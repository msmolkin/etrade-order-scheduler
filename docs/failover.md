# Failover runbook

This runbook covers swapping the active host for `etrade-trade-placer`
between the two configured hosts:

| Host           | User      | Tailscale IP   | Service mgmt   | Project path                                                                |
| -------------- | --------- | -------------- | -------------- | --------------------------------------------------------------------------- |
| `alienware-r8` | `michael` | `100.64.0.11`  | systemd        | `/home/michael/etrade-trade-placer/`                                        |
| `ryansoldmac`  | `clawd`   | `100.64.0.7`   | screen + macOS | `/Users/michael/Documents/2026/projects/etrade-trade-placer/`               |

## Roles

- **Active host** runs all four services (`server`, `scheduler`, `frontend`,
  `otp-relay`) and answers webhook traffic via Caddy on `ctdsu.com`.
- **Standby host** runs no app services; pulls git hourly from
  `smolkapps/etrade-trade-placer` and DB nightly via
  `etrade-sync-from-alienware.sh` into a parallel `etrade_trader_standby`
  database.
- The `relay.ctdsu.com` Caddy `reverse_proxy` line points at the active host.
  That line **is** the source of truth for "which host is active."

At any moment, **exactly one host is active.** The morning cron is enabled
on the active host only. Both hosts auth-ing would thrash E*TRADE OAuth
tokens (E*TRADE invalidates the previous session on a new login).

## Quick check: which host is active?

```bash
ssh ctdsu.com 'grep reverse_proxy /etc/caddy/Caddyfile | grep 3102'
```

- `100.64.0.11` -> alienware-r8 active
- `100.64.0.7`  -> ryansoldmac active

## Promote ryansoldmac (failover from alienware)

Run from operator's local Mac (or any host with SSH access to all three:
`michael@alienware-r8`, `clawd@ryansoldmac`, `ctdsu.com`):

```bash
bash scripts/promote-ryansoldmac.sh
```

The script is idempotent and prints what it's doing at each of six steps.
After it completes, do the cron toggles manually:

```bash
# Re-enable morning cron on ryansoldmac (was commented while standby):
ssh clawd@ryansoldmac \
  'crontab -l | sed -E "s|^# STANDBY - re-enable on failover: ||" | crontab -'

# Disable morning cron on alienware (now standby):
ssh michael@alienware-r8 \
  'crontab -l | sed -E "s|^(0 3 \* \* 1-5 .*etrade-morning\.sh.*)|# STANDBY - re-enable on failover: \1|" | crontab -'
```

Verify:

```bash
ssh ctdsu.com 'grep reverse_proxy /etc/caddy/Caddyfile | grep 3102'  # expect 100.64.0.7
ssh clawd@ryansoldmac 'screen -ls | grep etrade-'                    # expect 4 screens
ssh michael@alienware-r8 'systemctl is-active etrade-server'         # expect inactive
```

## Promote alienware (revert / failback)

```bash
bash scripts/promote-alienware.sh
```

Then mirror the cron toggles:

```bash
# Re-enable morning cron on alienware:
ssh michael@alienware-r8 \
  'crontab -l | sed -E "s|^# STANDBY - re-enable on failover: ||" | crontab -'

# Disable morning cron on ryansoldmac:
ssh clawd@ryansoldmac \
  'crontab -l | sed -E "s|^(0 3 \* \* 1-5 .*etrade-morning\.sh.*)|# STANDBY - re-enable on failover: \1|" | crontab -'
```

Verify:

```bash
ssh ctdsu.com 'grep reverse_proxy /etc/caddy/Caddyfile | grep 3102'   # expect 100.64.0.11
ssh michael@alienware-r8 'systemctl is-active etrade-server etrade-scheduler etrade-frontend etrade-otp-relay'
ssh clawd@ryansoldmac 'screen -ls 2>&1 | grep etrade- || echo no etrade screens'
```

## Edge case: in-flight order at cutover

If a scheduled order was being placed at the moment of cutover, E*TRADE
may have it but the new active host's DB may not (it lost the writes
between the last dump and cutover). After failover, query E*TRADE for
the last few hours of orders and reconcile by hand.

No automated reconciliation script yet. Backlog item: a script that calls
`getOrderStatus` against E*TRADE for each order with `submittedAt > <failover-time>`
and reconciles DB state.

## Rollback (if a promote-*.sh goes sideways)

The previous Caddy config is in `/etc/caddy/Caddyfile.bak.<timestamp>`
on the Hetzner VPS. Restore and reload:

```bash
ssh ctdsu.com '
  ls -t /etc/caddy/Caddyfile.bak.* | head -1
  sudo cp $(ls -t /etc/caddy/Caddyfile.bak.* | head -1) /etc/caddy/Caddyfile
  sudo caddy validate --config /etc/caddy/Caddyfile
  sudo systemctl reload caddy
'
```

Then start whichever host has the latest data. If both hosts have services
stopped, the last good dump is in `/var/backups/etrade/latest.dump` on
alienware (or `/Users/clawd/var/etrade-backups/latest.dump` on ryansoldmac).

## Standby health checks (run any time)

```bash
# Hourly git pull is happening:
ssh clawd@ryansoldmac 'tail -5 /tmp/etrade-git-pull.log; cd /Users/michael/Documents/2026/projects/etrade-trade-placer && git log --oneline -1'

# Nightly DB sync is happening:
ssh clawd@ryansoldmac '
  tail -5 /tmp/etrade-sync.log
  ls -lt /Users/clawd/var/etrade-backups/ | head -3
  sudo -u michael psql etrade_trader_standby -tAc "SELECT count(*) FROM orders"
'

# Primary's nightly dump is happening:
ssh michael@alienware-r8 '
  ls -lt /var/backups/etrade/ | head -3
  tail -5 /var/log/etrade-dump.log
'
```

## Inventory: where things live

- Migration plan that produced this layout: `docs/superpowers/plans/2026-04-25-migrate-to-alienware.md`
- Schedule and morning-flow timing: `docs/schedule.md`
- Cross-platform morning script (sources platform branch via `uname -s`): `etrade-morning.sh`
- Primary's nightly dump cron job: 22:30 ET on alienware, runs `scripts/dump-db.sh`
- Standby's nightly sync cron: 23:30 ET on ryansoldmac, runs `scripts/standby-sync-from-primary.sh` via the symlink at `/Users/clawd/bin/etrade-sync-from-alienware.sh`
- Standby's hourly git pull cron: top of every hour on ryansoldmac, `git pull --quiet smolkapps main`

## Why `smolkapps main` and not just `git pull`?

ryansoldmac's `origin` remote points at `msmolkin/etrade-order-scheduler.git`,
the original public repo, which has diverged from the active line of work.
The active remote is `smolkapps/etrade-trade-placer.git` (where alienware
pushes). The hourly cron and the manual `git fetch smolkapps && git merge --ff-only smolkapps/main`
pattern both pull from the right remote. Don't use bare `git pull` on
ryansoldmac — it would land on the wrong tree.
