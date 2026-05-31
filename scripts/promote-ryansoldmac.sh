#!/usr/bin/env bash
# Failover: promote ryansoldmac from standby to primary.
#
# Run from operator's local Mac (or any host with SSH access to all three:
# michael@alienware-r8, clawd@ryansoldmac, ctdsu.com).
#
# Idempotent / safe to re-run: each step uses `|| true` for conditions
# already in the desired state, and the Caddy sed is grep-guarded so a
# second run is a no-op. If a step fails halfway, fix the underlying
# issue and re-run.
#
# After this script: alienware is standby (services stopped), ryansoldmac
# is primary (screen sessions running, Caddy pointing at 100.64.0.7:3102).
# You still need to:
#   - re-enable morning cron on ryansoldmac (it's currently commented)
#   - comment out morning cron on alienware
# See docs/failover.md for the post-promote checklist.

set -euo pipefail

ALIENWARE_IP=100.64.0.11
RYANSOLDMAC_IP=100.64.0.7

echo "==> 1/6: Stopping etrade services on alienware (current primary)"
ssh michael@alienware-r8 '
  sudo systemctl stop etrade-server etrade-scheduler etrade-frontend etrade-otp-relay 2>&1 || true
  sleep 2
  systemctl is-active etrade-server etrade-scheduler etrade-frontend etrade-otp-relay 2>&1 | sort -u || true
'

echo "==> 2/6: Final pg_dump on alienware (ensures latest writes are captured)"
ssh michael@alienware-r8 '/home/michael/etrade-trade-placer/scripts/dump-db.sh 2>&1 | tail -3'

echo "==> 3/6: Pulling final dump and restoring to live etrade_trader on ryansoldmac"
ssh michael@alienware-r8 'cat /var/backups/etrade/latest.dump' | \
  ssh clawd@ryansoldmac 'cat > /tmp/etrade-failover.dump'
ssh clawd@ryansoldmac '
  ls -lh /tmp/etrade-failover.dump
  sudo -u michael pg_restore --clean --if-exists --no-owner --no-acl \
    -d etrade_trader /tmp/etrade-failover.dump 2>&1 | tail -5
  sudo -u michael psql etrade_trader -tAc "SELECT count(*) FROM orders"
'

echo "==> 4/6: Starting services on ryansoldmac via etrade-morning.sh"
# etrade-morning.sh on ryansoldmac uses the macOS/screen branch and will
# start server/scheduler/frontend/otp-relay screens, then run the auth flow.
# Non-fatal if it returns non-zero (e.g. OTP delivery hiccup); the screens
# may still be up and ready for manual auth. We capture the exit code and
# warn but continue, so Caddy still gets repointed.
if ssh clawd@ryansoldmac '/Users/michael/Documents/2026/projects/etrade-trade-placer/etrade-morning.sh' 2>&1 | tail -10; then
  echo "    morning.sh OK"
else
  echo "    WARN: morning.sh exited non-zero — services may need manual auth"
  echo "    check: ssh clawd@ryansoldmac 'screen -ls; tail /tmp/etrade-morning.log'"
fi

echo "==> 5/6: Re-pointing Caddy at ryansoldmac (${RYANSOLDMAC_IP}:3102)"
ssh ctdsu.com "
  set -euo pipefail
  if grep -qE 'reverse_proxy ${RYANSOLDMAC_IP}:3102' /etc/caddy/Caddyfile; then
    echo '    Caddy already points at ryansoldmac — no change'
  else
    sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.\$(date -u +%Y%m%dT%H%M%SZ)
    sudo sed -i 's|reverse_proxy ${ALIENWARE_IP}:3102|reverse_proxy ${RYANSOLDMAC_IP}:3102|' /etc/caddy/Caddyfile
    sudo caddy validate --config /etc/caddy/Caddyfile
    sudo systemctl reload caddy
    grep -E 'reverse_proxy 100\\.64\\.0\\.[0-9]+:3102' /etc/caddy/Caddyfile
  fi
"

echo "==> 6/6: Smoke test"
sleep 3
PUBLIC=$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'x-webhook-secret: wrong' https://relay.ctdsu.com/ || echo curl_failed)
echo "    public relay: http=${PUBLIC} (401 = healthy)"
ssh clawd@ryansoldmac 'curl -s http://127.0.0.1:3001/health 2>&1 | head -2 || echo "    LOCAL HEALTH FAILED — check screens"'

cat <<'POST'

==> Failover to ryansoldmac complete.

Next steps (manual):
  1. Re-enable morning cron on ryansoldmac:
       ssh clawd@ryansoldmac 'crontab -l | sed -E "s|^# STANDBY - re-enable on failover: ||" | crontab -'
  2. Disable morning cron on alienware:
       ssh michael@alienware-r8 'crontab -l | sed -E "s|^(0 3 \* \* 1-5 .*etrade-morning\.sh.*)|# STANDBY - re-enable on failover: \1|" | crontab -'
  3. Verify:
       ssh ctdsu.com 'grep reverse_proxy /etc/caddy/Caddyfile | grep 3102'   # expect 100.64.0.7
POST
