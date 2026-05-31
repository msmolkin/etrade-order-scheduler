# Migrate trade-placer from ryansoldmac to alienware

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the active etrade-trade-placer host from `ryansoldmac` (macOS 12, owned by `clawd`) to `alienware-r8` (Ubuntu 24.04, owned by `michael`). Keep ryansoldmac as a warm standby with the current code and a recent DB snapshot, plus a documented and scripted failover path so it can resume serving in <10 minutes when needed.

**Architecture:** Alienware-r8 (Tailscale `100.64.0.11`) becomes the primary. All app services (`server`, `scheduler`, `frontend`, `otp-relay`) run there as systemd units owned by user `michael`. PostgreSQL 14 (matching ryansoldmac's version, installed from PGDG) hosts the `etrade_trader` database locally. Caddy on the Hetzner VPS continues to terminate `https://relay.ctdsu.com` and reverse-proxy over Tailscale, but its upstream changes from `100.64.0.7:3102` (ryansoldmac) to `100.64.0.11:3102` (alienware). Apps Script and E\*TRADE see no change. Ryansoldmac runs no app services in standby mode but pulls the git repo hourly and the latest pg_dump nightly; failover requires running one script on each side and reloading Caddy.

**Tech Stack:** Node v24.13.0 (nvm), TypeScript via tsx, PostgreSQL 14 (PGDG repo on Ubuntu 24.04), systemd (Linux) replacing screen+launchd (macOS), Caddy on Hetzner, Tailscale via Headscale (`v.ctdsu.com`), E\*TRADE OAuth 1.0a.

---

## Architecture decision: warm standby

Three failover models were considered:

1. **Cold standby** — ryansoldmac has nothing running and re-syncs from scratch on failover. Simplest but slowest (~30 min RTO); code may be stale.
2. **Warm standby with periodic sync** ⟵ **chosen.** Ryansoldmac always has current code (hourly `git pull`) and a recent DB (nightly `pg_dump` pull). Failover restores latest dump, starts services, repoints Caddy. RTO 5–10 min, RPO ≈ last sync (default = up to 24 h).
3. **Hot standby with streaming replication** — Postgres physical streaming. RPO seconds, RTO minutes; most complex (WAL streaming, replication slots). Overkill for a workload of ~10 orders/day.

The trade-placer's data write rate is low. Losing up to 24 h of DB writes on failover means losing at most a handful of order rows — recoverable from E\*TRADE's order history if needed. The sync interval can be tightened later (hourly, 15-min) without architecture changes. Streaming replication is a future option if workload grows.

Two rules that fall out of this decision and govern everything else in the plan:

- **Only the active host runs the morning auth.** E\*TRADE's OAuth invalidates the previous session when a new login lands on the same account; both hosts auth-ing would thrash tokens. Standby disables its morning cron entirely.
- **Caddy is the source of truth for "which host is active."** Its `reverse_proxy` line is what the Apps Script webhook reaches. Whichever host's IP is in that line is, by definition, primary.

---

## File layout after migration

```
alienware-r8 (active):
  /home/michael/etrade-trade-placer/    git checkout, owned by michael
    .env                                  copied from ryansoldmac
  /etc/systemd/system/
    etrade-server.service
    etrade-scheduler.service
    etrade-frontend.service
    etrade-otp-relay.service
  /var/lib/postgresql/14/main/          PostgreSQL data directory
  /var/backups/etrade/                  outbound nightly dumps
  michael's crontab:
    0 3 * * 1-5 /home/michael/etrade-trade-placer/etrade-morning.sh ...
    30 22 * * * /home/michael/etrade-trade-placer/scripts/dump-db.sh

ryansoldmac (standby):
  /Users/michael/Documents/2026/projects/etrade-trade-placer/    existing checkout, kept current
  /Users/clawd/var/etrade-backups/                                latest dumps pulled from alienware
  clawd's crontab:
    # 0 3 * * 1-5 ... etrade-morning.sh   <- DISABLED (commented)
    0 * * * * cd .../etrade-trade-placer && git pull --quiet
    30 23 * * * /Users/clawd/bin/etrade-sync-from-alienware.sh
  All etrade screen sessions: STOPPED.
  com.etrade.otp-relay launchd plist: stopped/unloaded.

ctdsu.com (Hetzner — unchanged role, only upstream IP changes):
  /etc/caddy/Caddyfile:
    relay.ctdsu.com {
      reverse_proxy 100.64.0.11:3102      <- was 100.64.0.7:3102
    }
```

---

## Phase 1: Prepare alienware infrastructure (non-disruptive)

All of Phase 1 happens on alienware while ryansoldmac keeps serving. Nothing here can break production.

### Task 1.1: Inventory and timezone

**Files:** none

- [ ] **Step 1: SSH in.** `ssh michael@alienware-r8` — confirm prompt is `michael@smolkai-r8:~$`.
- [ ] **Step 2: Set the timezone to America/New_York.** Alienware is currently UTC; the cron expressions in this plan (`0 3 * * 1-5`, `0 4-19 * * 1-5`, `55 6 * * 1-5`) are written for ET, matching ryansoldmac.
  ```bash
  sudo timedatectl set-timezone America/New_York
  timedatectl | head -3
  ```
  Expected: `Time zone: America/New_York (E[D|S]T, ...)`
- [ ] **Step 3: Confirm tailscale.** `tailscale status | head -5` shows `100.64.0.11   alienware-r8 ...`.
- [ ] **Step 4: Confirm Hetzner reachability.** `tailscale ping -c 1 ctdsu-server` should print `pong`. (Caddy upstream-from-Hetzner test comes later — for now we just verify the path exists.)

### Task 1.2: Install PostgreSQL 14 from PGDG

We pin to 14 to match ryansoldmac so pg_dump is forward-and-backward compatible — failover restores work in either direction without surprise.

**Files:** none

- [ ] **Step 1: Add the PGDG apt repo.**
  ```bash
  sudo install -d /usr/share/postgresql-common/pgdg
  sudo curl -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    https://www.postgresql.org/media/keys/ACCC4CF8.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
    https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" | \
    sudo tee /etc/apt/sources.list.d/pgdg.list
  sudo apt-get update
  ```
- [ ] **Step 2: Install Postgres 14.**
  ```bash
  sudo apt-get install -y postgresql-14 postgresql-client-14
  ```
- [ ] **Step 3: Verify and start.**
  ```bash
  pg_isready -h /var/run/postgresql
  sudo systemctl status postgresql@14-main --no-pager | head -5
  ```
  Expected: `accepting connections` and `Active: active (running)`.

### Task 1.3: Create the `michael` Postgres role and `etrade_trader` database

The DATABASE_URL in `.env` is `postgresql://michael@localhost:5432/etrade_trader` and we want it to keep working unchanged. So we create a `michael` role on alienware Postgres with peer-auth login and ownership of the database.

**Files:** none

- [ ] **Step 1: Create the role.**
  ```bash
  sudo -u postgres createuser --superuser michael
  ```
  (Superuser is overkill for production but fine for a single-user dev box and removes a class of permission failures during migration.)
- [ ] **Step 2: Create the database.**
  ```bash
  sudo -u postgres createdb -O michael etrade_trader
  ```
- [ ] **Step 3: Verify peer auth from `michael`.**
  ```bash
  psql -d etrade_trader -c 'SELECT current_user, current_database();'
  ```
  Expected output:
  ```
   current_user | current_database
  --------------+------------------
   michael      | etrade_trader
  ```

### Task 1.4: Install Node v24.13.0 via nvm

**Files:** none

- [ ] **Step 1: Install nvm if missing.** Per CLAUDE.md, "nvm persists once installed" — check first.
  ```bash
  if [ ! -d "$HOME/.nvm" ]; then
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
    source ~/.bashrc
  fi
  ```
- [ ] **Step 2: Install the exact version ryansoldmac uses.**
  ```bash
  source ~/.nvm/nvm.sh
  nvm install v24.13.0
  nvm alias default v24.13.0
  node -v   # expect v24.13.0
  npm -v
  ```

### Task 1.5: Clone the project and install dependencies

**Files:** create `/home/michael/etrade-trade-placer/` (git checkout)

- [ ] **Step 1: Clone from the active remote.** Use `smolkapps` (the repo we've been pushing to in earlier commits).
  ```bash
  cd /home/michael
  git clone git@github.com:smolkapps/etrade-trade-placer.git
  cd etrade-trade-placer
  git log --oneline -3
  ```
  Expected: most recent commit hash matches `git log --oneline -1` on ryansoldmac. (If the SSH key for `git@github.com` isn't set up on alienware yet, generate one with `ssh-keygen -t ed25519 -f ~/.ssh/id_github`, add `~/.ssh/id_github.pub` to GitHub, and configure `~/.ssh/config` with a `Host github.com` block — same pattern as on ryansoldmac.)
- [ ] **Step 2: Install dependencies.**
  ```bash
  source ~/.nvm/nvm.sh
  cd /home/michael/etrade-trade-placer
  npm install
  ```
  Expected: completes without errors. If `node-gyp` builds anything that fails, install build tools: `sudo apt-get install -y build-essential python3`.
- [ ] **Step 3: TypeScript type-check sanity.**
  ```bash
  npx tsc --noEmit | head -20
  ```
  Expected: pre-existing errors only (`src/server/database/client.ts:30`, `src/scheduler/local-scheduler.ts:28`, etc.). No new errors specific to this checkout. (Same noise we see on ryansoldmac.)

### Task 1.6: Copy `.env` from ryansoldmac

This file holds E\*TRADE secrets, the webhook secret, the DATABASE_URL, etc. **It is not in git** and never should be.

**Files:** create `/home/michael/etrade-trade-placer/.env`

- [ ] **Step 1: From ryansoldmac, scp the file over.**
  ```bash
  ssh clawd@ryansoldmac \
    'cat /Users/michael/Documents/2026/projects/etrade-trade-placer/.env' > /tmp/etrade.env
  scp /tmp/etrade.env michael@alienware-r8:/home/michael/etrade-trade-placer/.env
  rm /tmp/etrade.env
  ```
  (Doing it via `cat | scp` to a temp file avoids ssh-key gymnastics for direct ryansoldmac→alienware transfer if the keys aren't paired in that direction.)
- [ ] **Step 2: Lock down perms.**
  ```bash
  ssh michael@alienware-r8 'chmod 600 /home/michael/etrade-trade-placer/.env'
  ```
- [ ] **Step 3: Confirm DATABASE_URL is correct.**
  ```bash
  ssh michael@alienware-r8 'grep DATABASE_URL /home/michael/etrade-trade-placer/.env'
  ```
  Expected: `DATABASE_URL=postgresql://michael@localhost:5432/etrade_trader`. If it's something different, edit it now.

### Task 1.7: Apply schema to the empty database

The schema includes the `parent_id` column added in commit `508e3d1`. Running `schema.sql` is idempotent (uses `CREATE TABLE IF NOT EXISTS` and conditional ALTER blocks).

**Files:** uses `src/server/database/schema.sql`

- [ ] **Step 1: Apply schema.**
  ```bash
  psql -d etrade_trader -f /home/michael/etrade-trade-placer/src/server/database/schema.sql
  ```
- [ ] **Step 2: Verify tables exist.**
  ```bash
  psql -d etrade_trader -c '\dt'
  ```
  Expected: `orders`, `order_executions`, `scheduled_order_locks` listed.
- [ ] **Step 3: Verify `parent_id` column exists.**
  ```bash
  psql -d etrade_trader -c '\d orders' | grep parent_id
  ```
  Expected: `parent_id | uuid | not null`.

### Task 1.8: Commit phase 1

**Files:** none (no code changes in this phase)

- [ ] **Step 1: Tag the inventory state.** No git commit needed — this phase is host configuration. Save a checklist of completed tasks to `/tmp/phase1-done.txt` for paper trail.

---

## Phase 2: Migrate the database

Two-step: (1) initial bulk dump+restore now (Phase 2), (2) a final delta dump+restore right before cutover (Phase 6 step 2). Doing it in two passes minimizes downtime — most of the data moves while ryansoldmac keeps serving, only the small delta moves during the actual switch.

### Task 2.1: Take the initial dump on ryansoldmac

**Files:** create `/tmp/etrade-initial-$(date +%Y%m%d).dump` on ryansoldmac

- [ ] **Step 1: Take the dump in custom format.** Custom format compresses well and supports parallel restore.
  ```bash
  ssh clawd@ryansoldmac \
    'sudo -u michael pg_dump -Fc etrade_trader > /tmp/etrade-initial.dump'
  ```
- [ ] **Step 2: Sanity-check size.**
  ```bash
  ssh clawd@ryansoldmac 'ls -lh /tmp/etrade-initial.dump'
  ```
  Expected: somewhere in the 5–50 MB range given the order-row counts seen earlier.

### Task 2.2: Transfer to alienware

**Files:** create `/tmp/etrade-initial.dump` on alienware

- [ ] **Step 1: Pipe via SSH (no third-party hop).**
  ```bash
  ssh clawd@ryansoldmac 'cat /tmp/etrade-initial.dump' | \
    ssh michael@alienware-r8 'cat > /tmp/etrade-initial.dump'
  ssh michael@alienware-r8 'ls -lh /tmp/etrade-initial.dump'
  ```
- [ ] **Step 2: Confirm sha matches both ends.**
  ```bash
  ssh clawd@ryansoldmac 'shasum -a 256 /tmp/etrade-initial.dump'
  ssh michael@alienware-r8 'sha256sum /tmp/etrade-initial.dump'
  ```
  Expected: identical hashes.

### Task 2.3: Restore on alienware

**Files:** populates `etrade_trader` on alienware

- [ ] **Step 1: Restore.** `--clean --if-exists` lets us re-run idempotently if something goes wrong.
  ```bash
  ssh michael@alienware-r8 \
    'pg_restore --clean --if-exists --no-owner --no-acl \
      -d etrade_trader /tmp/etrade-initial.dump 2>&1 | tail -20'
  ```
  Expected: ends without errors. (Warnings about `parent_id` constraint may appear if the dump has the older schema and our schema.sql had already added the column — those are safe to ignore; the column already has the constraint.)
- [ ] **Step 2: Verify row counts match.**
  ```bash
  ssh clawd@ryansoldmac \
    "sudo -u michael psql etrade_trader -tAc 'SELECT count(*) FROM orders'"
  ssh michael@alienware-r8 \
    "psql etrade_trader -tAc 'SELECT count(*) FROM orders'"
  ```
  Expected: same number on both sides.
- [ ] **Step 3: Spot-check a known recent order.**
  ```bash
  ssh michael@alienware-r8 \
    "psql etrade_trader -c \"SELECT id, symbol, status, created_at FROM orders WHERE symbol IN ('COUR','VXX','AMD') ORDER BY created_at DESC LIMIT 5\""
  ```
  Expected: same recent orders visible on both hosts.

---

## Phase 3: Create systemd services on alienware

Replace the macOS `screen` pattern with proper systemd units. Each service gets:

- `User=michael`
- `WorkingDirectory=/home/michael/etrade-trade-placer`
- `EnvironmentFile=/home/michael/etrade-trade-placer/.env`
- `Restart=on-failure` with backoff
- `StandardOutput=journal`

This means `journalctl -u etrade-server -f` replaces `tail -f /tmp/etrade-app.log`.

### Task 3.1: Write `etrade-server.service`

**Files:** create `/etc/systemd/system/etrade-server.service`

- [ ] **Step 1: Write the unit.**

  ```bash
  sudo tee /etc/systemd/system/etrade-server.service > /dev/null <<'UNIT'
  [Unit]
  Description=E*TRADE trade-placer API server
  After=network-online.target postgresql@14-main.service
  Wants=network-online.target

  [Service]
  Type=simple
  User=michael
  WorkingDirectory=/home/michael/etrade-trade-placer
  EnvironmentFile=/home/michael/etrade-trade-placer/.env
  ExecStart=/home/michael/.nvm/versions/node/v24.13.0/bin/npx tsx src/server/index.ts
  Restart=on-failure
  RestartSec=5
  StandardOutput=journal
  StandardError=journal

  [Install]
  WantedBy=multi-user.target
  UNIT
  ```

- [ ] **Step 2: Reload systemd.** `sudo systemctl daemon-reload`.
- [ ] **Step 3: Don't enable yet** — that happens in Phase 6 (cutover). For now just verify it parses: `systemctl cat etrade-server` prints the unit cleanly.

### Task 3.2: Write `etrade-scheduler.service`

**Files:** create `/etc/systemd/system/etrade-scheduler.service`

- [ ] **Step 1: Write the unit.** Identical shape to `etrade-server` but for the scheduler entrypoint and dependent on the server being up.

  ```bash
  sudo tee /etc/systemd/system/etrade-scheduler.service > /dev/null <<'UNIT'
  [Unit]
  Description=E*TRADE trade-placer scheduler (cron + due-orders + heartbeat)
  After=etrade-server.service
  Requires=etrade-server.service

  [Service]
  Type=simple
  User=michael
  WorkingDirectory=/home/michael/etrade-trade-placer
  EnvironmentFile=/home/michael/etrade-trade-placer/.env
  ExecStart=/home/michael/.nvm/versions/node/v24.13.0/bin/npx tsx src/scheduler/local-scheduler.ts
  Restart=on-failure
  RestartSec=5
  StandardOutput=journal
  StandardError=journal

  [Install]
  WantedBy=multi-user.target
  UNIT
  sudo systemctl daemon-reload
  ```

### Task 3.3: Write `etrade-frontend.service`

**Files:** create `/etc/systemd/system/etrade-frontend.service`

Vite dev server is what serves the UI on port 3000. (For a "real" deployment we'd `npm run build` and serve static — out of scope here.)

- [ ] **Step 1: Write the unit.**

  ```bash
  sudo tee /etc/systemd/system/etrade-frontend.service > /dev/null <<'UNIT'
  [Unit]
  Description=E*TRADE trade-placer Vite frontend
  After=network-online.target
  Wants=network-online.target

  [Service]
  Type=simple
  User=michael
  WorkingDirectory=/home/michael/etrade-trade-placer
  ExecStart=/home/michael/.nvm/versions/node/v24.13.0/bin/npx vite --host --port 3000
  Restart=on-failure
  RestartSec=5
  StandardOutput=journal
  StandardError=journal

  [Install]
  WantedBy=multi-user.target
  UNIT
  sudo systemctl daemon-reload
  ```

### Task 3.4: Write `etrade-otp-relay.service`

**Files:** create `/etc/systemd/system/etrade-otp-relay.service`

The relay needs the same environment vars the screen-launched version on ryansoldmac uses (`RELAY_PORT=3102`, `RELAY_HOST=0.0.0.0`, `RELAY_UPSTREAM_URL`, `RELAY_SHARED_SECRET`). These live in `.generated/otp-relay/etrade-otp-relay.env`. Reference that file directly.

- [ ] **Step 1: Confirm the generated env file came over with the git checkout.**
  ```bash
  ssh michael@alienware-r8 \
    'ls -la /home/michael/etrade-trade-placer/.generated/otp-relay/etrade-otp-relay.env'
  ```
  If absent (it's gitignored on some setups), copy it from ryansoldmac the same way as `.env` in Task 1.6.
- [ ] **Step 2: Write the unit.**

  ```bash
  sudo tee /etc/systemd/system/etrade-otp-relay.service > /dev/null <<'UNIT'
  [Unit]
  Description=E*TRADE OTP webhook relay (Caddy → 3102 → main app)
  After=etrade-server.service network-online.target
  Wants=etrade-server.service network-online.target

  [Service]
  Type=simple
  User=michael
  WorkingDirectory=/home/michael/etrade-trade-placer
  EnvironmentFile=/home/michael/etrade-trade-placer/.generated/otp-relay/etrade-otp-relay.env
  Environment=RELAY_HOST=0.0.0.0
  ExecStart=/home/michael/.nvm/versions/node/v24.13.0/bin/node \
    /home/michael/etrade-trade-placer/docs/google-apps-script/otp-webhook-relay.mjs
  Restart=always
  RestartSec=5
  StandardOutput=journal
  StandardError=journal

  [Install]
  WantedBy=multi-user.target
  UNIT
  sudo systemctl daemon-reload
  ```

  Note `Restart=always` (not just `on-failure`) — the relay is the most failure-sensitive piece because if it's down, the next morning auth can't complete and 7 AM orders will fail to place.

### Task 3.5: Smoke-test each service in isolation (do NOT enable yet)

We start each one, confirm it boots clean, then stop it. Real start/enable happens in Phase 6.

- [ ] **Step 1: Server.**
  ```bash
  sudo systemctl start etrade-server
  sleep 5
  curl -s http://127.0.0.1:3001/health
  # expect: {"status":"healthy","database":true,...}
  sudo systemctl stop etrade-server
  ```
- [ ] **Step 2: Frontend.**
  ```bash
  sudo systemctl start etrade-frontend
  sleep 8
  curl -sI http://127.0.0.1:3000/ | head -1
  # expect: HTTP/1.1 200 OK
  sudo systemctl stop etrade-frontend
  ```
- [ ] **Step 3: OTP relay.**
  ```bash
  sudo systemctl start etrade-otp-relay
  sleep 3
  curl -sS -o /dev/null -w '%{http_code}\n' \
    -X POST -H 'x-webhook-secret: wrong' http://127.0.0.1:3102/
  # expect: 401  (relay is up, secret check is rejecting)
  sudo systemctl stop etrade-otp-relay
  ```
- [ ] **Step 4: Scheduler.** This one will try to reach E\*TRADE on startup (refreshCredentials → heartbeat). If tokens are expired/the active host is still ryansoldmac, you may see errors. Just confirm it doesn't crash:
  ```bash
  sudo systemctl start etrade-server etrade-scheduler
  sleep 8
  sudo systemctl status etrade-scheduler --no-pager | head -15
  # expect: "active (running)" — exits-on-failure would show "failed"
  sudo journalctl -u etrade-scheduler -n 20 --no-pager | tail -10
  # expect: "Local scheduler started successfully" banner
  sudo systemctl stop etrade-scheduler etrade-server
  ```

---

## Phase 4: Adapt `etrade-morning.sh` for Linux/systemd

The current morning script uses `screen -S` to manage long-running services and relies on macOS `pkill -f` patterns. On alienware we use systemd. The script needs a small rewrite — but we keep the same overall shape (start/restart services → trigger /api/auth/auto → wait → restart server+scheduler to pick up tokens) so failover scripts can reuse it conceptually.

### Task 4.1: Add a `--linux` mode to `etrade-morning.sh`

**Files:** modify `/home/michael/etrade-trade-placer/etrade-morning.sh` (will be committed back to repo so ryansoldmac sees it via hourly git-pull)

We don't fork the script — we add a runtime branch. Detect platform via `uname -s` and use systemd commands when on Linux, screen/pkill when on macOS. This way both hosts run the same script unchanged.

- [ ] **Step 1: Write the failing test first.** Create `/home/michael/etrade-trade-placer/scripts/test-morning-platform-detection.sh`:
  ```bash
  cat > /home/michael/etrade-trade-placer/scripts/test-morning-platform-detection.sh <<'TEST'
  #!/usr/bin/env bash
  # Sources etrade-morning.sh's platform-detection block in dry-run mode and
  # verifies the right service-management functions get defined.
  set -euo pipefail
  export ETRADE_MORNING_DRY_RUN=1
  source /home/michael/etrade-trade-placer/etrade-morning.sh
  if [[ "$(uname -s)" == "Linux" ]]; then
    type start_service | grep -q systemctl || { echo "FAIL: Linux should use systemctl"; exit 1; }
  else
    type start_service | grep -q screen || { echo "FAIL: macOS should use screen"; exit 1; }
  fi
  echo "PASS"
  TEST
  chmod +x /home/michael/etrade-trade-placer/scripts/test-morning-platform-detection.sh
  ```
- [ ] **Step 2: Run it; it should fail** because `start_service` isn't defined and `ETRADE_MORNING_DRY_RUN` isn't a thing.
  ```bash
  /home/michael/etrade-trade-placer/scripts/test-morning-platform-detection.sh
  # expect: FAIL or error
  ```
- [ ] **Step 3: Patch `etrade-morning.sh`.** Add at the very top (after the existing `set -euo pipefail`):

  ```bash
  # --- Platform detection: choose service-management primitives ---
  if [[ "$(uname -s)" == "Linux" ]]; then
    start_service()   { sudo systemctl start "etrade-$1"; }
    restart_service() { sudo systemctl restart "etrade-$1"; }
    stop_service()    { sudo systemctl stop "etrade-$1" 2>/dev/null || true; }
    is_running()      { systemctl is-active --quiet "etrade-$1"; }
  else
    # macOS / ryansoldmac legacy path
    start_service() {
      local name=$1 cmd=$2
      screen -dmS "etrade-$name" bash -c "cd $PROJECT_DIR && source .env && export \$(grep -v '^#' .env | xargs) && exec $cmd >> /tmp/etrade-$name.log 2>&1"
    }
    restart_service() { stop_service "$1"; sleep 1; start_service "$@"; }
    stop_service()    { screen -S "etrade-$1" -X quit 2>/dev/null || true; pkill -f "$1" 2>/dev/null || true; }
    is_running()      { screen -ls 2>/dev/null | grep -q "etrade-$1"; }
  fi

  # Allow scripts that source this file (tests) to skip the actual run.
  [[ -n "${ETRADE_MORNING_DRY_RUN:-}" ]] && return 0 2>/dev/null
  ```

- [ ] **Step 4: Replace the existing screen-launch blocks** further down in the script with calls to `start_service` / `restart_service`. (The existing `pkill` + `screen -S etrade-server -X quit` blocks become single `restart_service server` calls.)
- [ ] **Step 5: Re-run the test** — should pass on alienware:
  ```bash
  /home/michael/etrade-trade-placer/scripts/test-morning-platform-detection.sh
  # expect: PASS
  ```
- [ ] **Step 6: Cross-check on ryansoldmac.** SSH there, source the (just-pushed) script in dry-run mode, confirm the macOS branch is taken:
  ```bash
  ssh clawd@ryansoldmac 'cd /Users/michael/Documents/2026/projects/etrade-trade-placer && git pull --quiet && ETRADE_MORNING_DRY_RUN=1 bash -c "source ./etrade-morning.sh; type start_service" | head -3'
  # expect: "start_service is a function" with screen body
  ```
  (We won't actually execute morning on ryansoldmac during this plan; this just confirms the script is still safe there.)
- [ ] **Step 7: Commit.**
  ```bash
  cd /home/michael/etrade-trade-placer
  git add etrade-morning.sh scripts/test-morning-platform-detection.sh
  git commit -m "Cross-platform morning script: Linux/systemd + macOS/screen branches"
  git push origin main
  ```

### Task 4.2: Install morning cron on alienware

**Files:** michael's crontab on alienware

- [ ] **Step 1: Add the cron line.** Use `crontab -l | { cat; echo "..."; } | crontab -` to append safely.
  ```bash
  ( ssh michael@alienware-r8 'crontab -l 2>/dev/null'; \
    echo '0 3 * * 1-5 /home/michael/etrade-trade-placer/etrade-morning.sh >> /var/log/etrade-morning.log 2>&1' \
  ) | ssh michael@alienware-r8 'crontab -'
  ssh michael@alienware-r8 'crontab -l'
  ```
- [ ] **Step 2: Set up sudo NOPASSWD for the systemctl calls** the script makes. Edit visudo:
  ```bash
  ssh michael@alienware-r8 'sudo visudo -f /etc/sudoers.d/etrade'
  ```
  Add:
  ```
  michael ALL=(root) NOPASSWD: /bin/systemctl start etrade-*, /bin/systemctl stop etrade-*, /bin/systemctl restart etrade-*, /bin/systemctl is-active etrade-*
  ```
- [ ] **Step 3: Smoke-test the morning script manually** (not at 3 AM yet — interactive run to verify it works). Note: this DOES trigger /api/auth/auto, so only run when you can babysit the OTP.
  ```bash
  ssh michael@alienware-r8 'sudo /home/michael/etrade-trade-placer/etrade-morning.sh 2>&1 | tee /var/log/etrade-morning.log'
  ```
  Expected: services start, /api/auth/auto returns `requiresTwoFactorCode`, Apps Script + relay deliver OTP within 1–2 min, server+scheduler restart, market-data scripts run.

---

## Phase 5: Outbound DB-dump cron on alienware

Standby ryansoldmac will pull these. We make alienware ship the dumps to a known location with rotation.

### Task 5.1: Write `scripts/dump-db.sh`

**Files:** create `/home/michael/etrade-trade-placer/scripts/dump-db.sh`

- [ ] **Step 1: Write the script.**

  ```bash
  cat > /home/michael/etrade-trade-placer/scripts/dump-db.sh <<'SH'
  #!/usr/bin/env bash
  # Daily pg_dump for the standby to pull. Rotates older than 14 days.
  set -euo pipefail
  BACKUP_DIR=/var/backups/etrade
  STAMP=$(date -u +%Y%m%dT%H%M%SZ)
  OUT="$BACKUP_DIR/etrade-$STAMP.dump"

  sudo install -d -o michael -g michael "$BACKUP_DIR"
  pg_dump -Fc etrade_trader > "$OUT.tmp"
  mv "$OUT.tmp" "$OUT"
  ln -sfn "$OUT" "$BACKUP_DIR/latest.dump"

  # Rotate: keep last 14 days
  find "$BACKUP_DIR" -name 'etrade-*.dump' -mtime +14 -delete

  echo "[$(date -u +%FT%TZ)] dumped $(stat -c %s "$OUT") bytes -> $OUT"
  SH
  chmod +x /home/michael/etrade-trade-placer/scripts/dump-db.sh
  ```

- [ ] **Step 2: Smoke-test.**
  ```bash
  ssh michael@alienware-r8 '/home/michael/etrade-trade-placer/scripts/dump-db.sh'
  ssh michael@alienware-r8 'ls -lh /var/backups/etrade/'
  # expect: latest.dump symlink + at least one timestamped dump
  ```
- [ ] **Step 3: Cron entry on alienware.** 22:30 ET (after all market activity is done for the day).
  ```bash
  ( ssh michael@alienware-r8 'crontab -l'; \
    echo '30 22 * * * /home/michael/etrade-trade-placer/scripts/dump-db.sh >> /var/log/etrade-dump.log 2>&1' \
  ) | ssh michael@alienware-r8 'crontab -'
  ```
- [ ] **Step 4: Commit script.**
  ```bash
  cd /home/michael/etrade-trade-placer
  git add scripts/dump-db.sh
  git commit -m "Add nightly pg_dump script for standby pulls"
  git push origin main
  ```

---

## Phase 6: Cutover — make alienware primary

This is the only phase with user-visible downtime. Plan to do it during a market-closed window (evening or weekend) so no scheduled order placement is in flight.

**Estimated downtime:** 2–5 minutes (relay 502s during the window between Caddy reload and alienware services being healthy).

### Task 6.1: Stop services on ryansoldmac

**Files:** none

- [ ] **Step 1: Quit screen sessions.**
  ```bash
  ssh clawd@ryansoldmac '
    screen -S etrade-server -X quit 2>/dev/null
    screen -S etrade-scheduler -X quit 2>/dev/null
    screen -S etrade-frontend -X quit 2>/dev/null
    screen -S etrade-otp-relay -X quit 2>/dev/null
    sleep 2
    pkill -f "src/server/index.ts" 2>/dev/null
    pkill -f "local-scheduler" 2>/dev/null
    pkill -f "vite --host" 2>/dev/null
    pkill -f "otp-webhook-relay" 2>/dev/null
    sleep 1
    screen -ls 2>&1 | head
  '
  ```
  Expected: "No Sockets found" or only `etrade-` sessions absent.
- [ ] **Step 2: Confirm nothing listening on the app ports.**
  ```bash
  ssh clawd@ryansoldmac 'lsof -iTCP -sTCP:LISTEN -n -P 2>/dev/null | grep -E ":300[01]|:3102" || echo "ports clear"'
  ```
  Expected: `ports clear`.

### Task 6.2: Take final delta dump and ship it

**Files:** create `/tmp/etrade-cutover.dump` on both sides

- [ ] **Step 1: Final dump on ryansoldmac.**
  ```bash
  ssh clawd@ryansoldmac 'sudo -u michael pg_dump -Fc etrade_trader > /tmp/etrade-cutover.dump'
  ssh clawd@ryansoldmac 'ls -lh /tmp/etrade-cutover.dump; shasum -a 256 /tmp/etrade-cutover.dump'
  ```
- [ ] **Step 2: Pipe to alienware.**
  ```bash
  ssh clawd@ryansoldmac 'cat /tmp/etrade-cutover.dump' | \
    ssh michael@alienware-r8 'cat > /tmp/etrade-cutover.dump'
  ssh michael@alienware-r8 'sha256sum /tmp/etrade-cutover.dump'
  ```
  Hashes must match.
- [ ] **Step 3: Restore on alienware (this overwrites Phase 2's data with the latest).**
  ```bash
  ssh michael@alienware-r8 \
    'pg_restore --clean --if-exists --no-owner --no-acl \
      -d etrade_trader /tmp/etrade-cutover.dump 2>&1 | tail -10'
  ssh michael@alienware-r8 \
    "psql etrade_trader -tAc 'SELECT count(*) FROM orders'"
  ```
  Row count must equal the cutover-time count from ryansoldmac.

### Task 6.3: Enable + start systemd services on alienware

**Files:** none

- [ ] **Step 1: Enable for boot.**
  ```bash
  ssh michael@alienware-r8 \
    'sudo systemctl enable etrade-server etrade-scheduler etrade-frontend etrade-otp-relay'
  ```
- [ ] **Step 2: Start in dependency order.** systemd handles the order via `Requires=`/`After=`, but starting the leaf (`etrade-otp-relay`, `etrade-scheduler`) pulls the rest up.
  ```bash
  ssh michael@alienware-r8 'sudo systemctl start etrade-otp-relay etrade-scheduler etrade-frontend'
  sleep 8
  ssh michael@alienware-r8 'systemctl is-active etrade-server etrade-scheduler etrade-frontend etrade-otp-relay'
  ```
  Expected: `active` four times.
- [ ] **Step 3: Health-check.**
  ```bash
  ssh michael@alienware-r8 'curl -s http://127.0.0.1:3001/health'
  ssh michael@alienware-r8 'curl -sI http://127.0.0.1:3000/ | head -1'
  ssh michael@alienware-r8 'curl -sS -o /dev/null -w %{http_code} -X POST -H "x-webhook-secret: wrong" http://127.0.0.1:3102/'
  ```
  Expected: `{"status":"healthy"...}`, `HTTP/1.1 200 OK`, `401`.

### Task 6.4: Update Caddy upstream on Hetzner

**Files:** modify `/etc/caddy/Caddyfile` on `ctdsu.com`

- [ ] **Step 1: Backup the current Caddyfile.**
  ```bash
  ssh ctdsu.com 'sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.$(date -u +%Y%m%dT%H%M%SZ)'
  ```
- [ ] **Step 2: Patch the relay block.**
  ```bash
  ssh ctdsu.com "sudo sed -i 's|reverse_proxy 100.64.0.7:3102|reverse_proxy 100.64.0.11:3102|' /etc/caddy/Caddyfile"
  ssh ctdsu.com 'grep -A 5 "relay.ctdsu.com" /etc/caddy/Caddyfile'
  ```
  Expected: `reverse_proxy 100.64.0.11:3102` appears in the `relay.ctdsu.com` block.
- [ ] **Step 3: Validate config + reload.**
  ```bash
  ssh ctdsu.com 'sudo caddy validate --config /etc/caddy/Caddyfile'
  ssh ctdsu.com 'sudo systemctl reload caddy'
  ```
  Expected: `Valid configuration` and a clean reload (no error in `journalctl -u caddy -n 10`).

### Task 6.5: End-to-end verification

**Files:** none

- [ ] **Step 1: Public URL still answers from outside Tailscale.**
  ```bash
  curl -sS -o /dev/null -w 'http=%{http_code}\n' -X POST \
    -H 'x-webhook-secret: wrong' https://relay.ctdsu.com/
  ```
  Expected: `http=401` (relay rejecting wrong secret = full chain working).
- [ ] **Step 2: Manually trigger the Apps Script** (`pollEtradeOtpEmail` in the script editor) and watch alienware logs:
  ```bash
  ssh michael@alienware-r8 'sudo journalctl -u etrade-otp-relay -f &  sleep 30; kill %1'
  ```
  Expected: a `200` log line showing the webhook was forwarded. (If there's no fresh OTP email, Apps Script logs `No matching unprocessed E*TRADE OTP emails found` — also fine; means the path is intact, just nothing to deliver.)
- [ ] **Step 3: Watch for the next heartbeat** — should fire on the top of the next hour, 04:00–19:00 ET on weekdays:
  ```bash
  ssh michael@alienware-r8 'sudo journalctl -u etrade-scheduler --since "10 minutes ago" | grep heartbeat'
  ```
  Expected (after the next top-of-hour): `heartbeat: renew OK status=200`.
- [ ] **Step 4: Confirm UI is up at the new URL.** Hit `http://alienware-r8:3000/` in the browser; AuthWidget should render and `Authenticated` badge should show (tokens are fresh from the morning script's last run on ryansoldmac, replicated via the dump).

---

## Phase 7: Configure ryansoldmac as the standby

### Task 7.1: Disable the morning cron on ryansoldmac

**Files:** clawd's crontab

- [ ] **Step 1: Comment out the morning line, don't delete it.** That way the standby runbook can re-enable it with one sed in failover.
  ```bash
  ssh clawd@ryansoldmac '
    crontab -l | sed -E "s|^(0 3 \* \* 1-5 /Users/michael/Documents/2026/projects/etrade-trade-placer/etrade-morning.sh.*)|# STANDBY - re-enable on failover: \1|" | crontab -
    crontab -l
  '
  ```
  Expected: morning line prefixed with `# STANDBY - re-enable on failover:`.
- [ ] **Step 2: Unload the OTP-relay launchd plist** (it's still loaded from earlier work):
  ```bash
  ssh clawd@ryansoldmac '
    launchctl unload ~/Library/LaunchAgents/com.etrade.otp-relay.plist 2>&1 || true
    launchctl list | grep otp-relay && echo "STILL LOADED" || echo "unloaded"
  '
  ```

### Task 7.2: Hourly git pull on ryansoldmac

**Files:** clawd's crontab

- [ ] **Step 1: Append the cron line.**
  ```bash
  ssh clawd@ryansoldmac '
    ( crontab -l; echo "0 * * * * cd /Users/michael/Documents/2026/projects/etrade-trade-placer && /usr/bin/git pull --quiet >> /tmp/etrade-git-pull.log 2>&1" ) | crontab -
    crontab -l | tail -3
  '
  ```

### Task 7.3: Nightly DB sync on ryansoldmac

**Files:** create `/Users/clawd/bin/etrade-sync-from-alienware.sh`

- [ ] **Step 1: Write the script.**

  ```bash
  ssh clawd@ryansoldmac 'cat > /Users/clawd/bin/etrade-sync-from-alienware.sh' <<'SH'
  #!/usr/bin/env bash
  # Pull the latest pg_dump from alienware. Restores into a *separate* DB
  # called etrade_trader_standby — the live etrade_trader is left untouched
  # so that a ryansoldmac-restart-during-promote doesn't lose data. The
  # actual rename happens during failover (see scripts/promote-ryansoldmac.sh).
  set -euo pipefail
  STAMP=$(date -u +%Y%m%dT%H%M%SZ)
  BACKUP_DIR=/Users/clawd/var/etrade-backups
  mkdir -p "$BACKUP_DIR"
  OUT="$BACKUP_DIR/etrade-$STAMP.dump"

  ssh michael@alienware-r8 'cat /var/backups/etrade/latest.dump' > "$OUT"
  ln -sfn "$OUT" "$BACKUP_DIR/latest.dump"

  # Restore into a parallel DB so the live one stays clean while standby.
  sudo -u michael psql -c 'DROP DATABASE IF EXISTS etrade_trader_standby' postgres
  sudo -u michael psql -c 'CREATE DATABASE etrade_trader_standby' postgres
  sudo -u michael pg_restore --no-owner --no-acl -d etrade_trader_standby "$OUT"

  # Retention: 14 days
  find "$BACKUP_DIR" -name 'etrade-*.dump' -mtime +14 -delete

  echo "[$(date -u +%FT%TZ)] synced $(stat -f %z "$OUT" 2>/dev/null || stat -c %s "$OUT") bytes from alienware"
  SH
  ssh clawd@ryansoldmac 'chmod +x /Users/clawd/bin/etrade-sync-from-alienware.sh'
  ```

- [ ] **Step 2: Smoke-test once.**
  ```bash
  ssh clawd@ryansoldmac '/Users/clawd/bin/etrade-sync-from-alienware.sh'
  ssh clawd@ryansoldmac 'sudo -u michael psql etrade_trader_standby -tAc "SELECT count(*) FROM orders"'
  ```
  Expected: prints a row count matching alienware's live count.
- [ ] **Step 3: Cron entry.** 23:30 ET (after alienware's 22:30 dump completes).
  ```bash
  ssh clawd@ryansoldmac '
    ( crontab -l; echo "30 23 * * * /Users/clawd/bin/etrade-sync-from-alienware.sh >> /tmp/etrade-sync.log 2>&1" ) | crontab -
    crontab -l
  '
  ```

---

## Phase 8: Failover scripts and runbook

### Task 8.1: `scripts/promote-ryansoldmac.sh` (run from operator's local Mac)

**Files:** create `/home/michael/etrade-trade-placer/scripts/promote-ryansoldmac.sh`

- [ ] **Step 1: Write the script.**

  ```bash
  cat > /home/michael/etrade-trade-placer/scripts/promote-ryansoldmac.sh <<'SH'
  #!/usr/bin/env bash
  # Failover: alienware -> ryansoldmac. Run from operator's local Mac
  # (somewhere with SSH access to all three hosts: ryansoldmac, alienware-r8, ctdsu.com).
  set -euo pipefail
  echo "==> 1/6: Stopping services on alienware"
  ssh michael@alienware-r8 'sudo systemctl stop etrade-server etrade-scheduler etrade-frontend etrade-otp-relay'

  echo "==> 2/6: Final dump on alienware"
  ssh michael@alienware-r8 '/home/michael/etrade-trade-placer/scripts/dump-db.sh >> /var/log/etrade-dump.log'

  echo "==> 3/6: Pulling final dump and restoring to live DB on ryansoldmac"
  ssh michael@alienware-r8 'cat /var/backups/etrade/latest.dump' | \
    ssh clawd@ryansoldmac 'cat > /tmp/etrade-failover.dump'
  ssh clawd@ryansoldmac '
    sudo -u michael pg_restore --clean --if-exists --no-owner --no-acl \
      -d etrade_trader /tmp/etrade-failover.dump 2>&1 | tail -5
  '

  echo "==> 4/6: Starting services on ryansoldmac"
  ssh clawd@ryansoldmac '/Users/michael/Documents/2026/projects/etrade-trade-placer/etrade-morning.sh' || \
    echo "WARN: morning.sh exited non-zero — check /tmp/etrade-morning.log"

  echo "==> 5/6: Re-pointing Caddy at ryansoldmac"
  ssh ctdsu.com '
    sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.$(date -u +%Y%m%dT%H%M%SZ)
    sudo sed -i "s|reverse_proxy 100.64.0.11:3102|reverse_proxy 100.64.0.7:3102|" /etc/caddy/Caddyfile
    sudo caddy validate --config /etc/caddy/Caddyfile
    sudo systemctl reload caddy
  '

  echo "==> 6/6: Smoke test"
  curl -sS -o /dev/null -w 'public_relay=%{http_code}\n' -X POST -H "x-webhook-secret: wrong" https://relay.ctdsu.com/
  ssh clawd@ryansoldmac 'curl -s http://127.0.0.1:3001/health'

  echo "==> Failover to ryansoldmac complete. Re-enable morning cron on ryansoldmac and disable on alienware."
  SH
  chmod +x /home/michael/etrade-trade-placer/scripts/promote-ryansoldmac.sh
  ```

### Task 8.2: `scripts/promote-alienware.sh` (mirror)

**Files:** create `/home/michael/etrade-trade-placer/scripts/promote-alienware.sh`

- [ ] **Step 1: Write the symmetric script.** Same six-step shape, swap source/destination, swap Caddy IPs (`100.64.0.7` → `100.64.0.11`).

  ```bash
  cat > /home/michael/etrade-trade-placer/scripts/promote-alienware.sh <<'SH'
  #!/usr/bin/env bash
  set -euo pipefail
  echo "==> 1/6: Stopping services on ryansoldmac"
  ssh clawd@ryansoldmac '
    for svc in etrade-server etrade-scheduler etrade-frontend etrade-otp-relay; do
      screen -S "$svc" -X quit 2>/dev/null || true
    done
    pkill -f "src/server/index.ts" 2>/dev/null || true
    pkill -f "local-scheduler" 2>/dev/null || true
    pkill -f "vite --host" 2>/dev/null || true
    pkill -f "otp-webhook-relay" 2>/dev/null || true
    sleep 2
  '

  echo "==> 2/6: Final dump on ryansoldmac"
  ssh clawd@ryansoldmac 'sudo -u michael pg_dump -Fc etrade_trader > /tmp/etrade-failover.dump'

  echo "==> 3/6: Restoring to live DB on alienware"
  ssh clawd@ryansoldmac 'cat /tmp/etrade-failover.dump' | \
    ssh michael@alienware-r8 'cat > /tmp/etrade-failover.dump'
  ssh michael@alienware-r8 '
    pg_restore --clean --if-exists --no-owner --no-acl \
      -d etrade_trader /tmp/etrade-failover.dump 2>&1 | tail -5
  '

  echo "==> 4/6: Starting services on alienware"
  ssh michael@alienware-r8 'sudo systemctl start etrade-otp-relay etrade-scheduler etrade-frontend'
  sleep 8
  ssh michael@alienware-r8 'systemctl is-active etrade-server etrade-scheduler etrade-frontend etrade-otp-relay'

  echo "==> 5/6: Re-pointing Caddy at alienware"
  ssh ctdsu.com '
    sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.$(date -u +%Y%m%dT%H%M%SZ)
    sudo sed -i "s|reverse_proxy 100.64.0.7:3102|reverse_proxy 100.64.0.11:3102|" /etc/caddy/Caddyfile
    sudo caddy validate --config /etc/caddy/Caddyfile
    sudo systemctl reload caddy
  '

  echo "==> 6/6: Smoke test"
  curl -sS -o /dev/null -w 'public_relay=%{http_code}\n' -X POST -H "x-webhook-secret: wrong" https://relay.ctdsu.com/
  ssh michael@alienware-r8 'curl -s http://127.0.0.1:3001/health'

  echo "==> Failover to alienware complete. Re-enable morning cron on alienware and disable on ryansoldmac."
  SH
  chmod +x /home/michael/etrade-trade-placer/scripts/promote-alienware.sh
  ```

### Task 8.3: Runbook `docs/failover.md`

**Files:** create `/home/michael/etrade-trade-placer/docs/failover.md`

- [ ] **Step 1: Write the doc.**

  ```bash
  cat > /home/michael/etrade-trade-placer/docs/failover.md <<'MD'
  # Failover runbook

  ## Roles

  - **Active host** runs all four systemd/screen services and answers via Caddy.
  - **Standby host** runs no app services; pulls git hourly and DB nightly.
  - The `relay.ctdsu.com` Caddy `reverse_proxy` line points at the active host.

  At any moment, exactly one host is active. The morning cron is enabled on the active host only.

  ## Quick check: which host is active?

      ssh ctdsu.com "grep reverse_proxy /etc/caddy/Caddyfile | grep 3102"

  - `100.64.0.11` -> alienware-r8 active
  - `100.64.0.7` -> ryansoldmac active

  ## Promote ryansoldmac (standard failover)

  Run from the operator's local Mac:

      bash scripts/promote-ryansoldmac.sh

  Then on ryansoldmac:

      ssh clawd@ryansoldmac 'crontab -l | sed -E "s|^# STANDBY - re-enable on failover: ||" | crontab -'

  And on alienware:

      ssh michael@alienware-r8 'crontab -l | sed -E "s|^(0 3 \* \* 1-5 /home/michael.*etrade-morning\.sh.*)|# STANDBY: \1|" | crontab -'

  ## Promote alienware (revert)

      bash scripts/promote-alienware.sh

  Then re-enable alienware cron and disable ryansoldmac cron in mirror.

  ## Edge case: in-flight order at cutover

  If a scheduled order was being placed at the moment of cutover, E*TRADE may have it but the new active host's DB may not. After failover, query E*TRADE for the last hour of orders and reconcile by hand (no automated reconciliation script yet — see backlog).

  ## Rollback

  If failover goes sideways, the previous Caddy config is in `/etc/caddy/Caddyfile.bak.<timestamp>`. Restore and reload:

      ssh ctdsu.com 'sudo cp /etc/caddy/Caddyfile.bak.<TS> /etc/caddy/Caddyfile && sudo systemctl reload caddy'

  Then start whichever host has the latest data.

  ## Inventory: where things live

  See `docs/schedule.md` for the schedule and `docs/superpowers/plans/2026-04-25-migrate-to-alienware.md` for the migration plan that produced this layout.
  MD
  ```

### Task 8.4: Commit failover scripts and runbook

**Files:** none new

- [ ] **Step 1: Commit and push.**
  ```bash
  cd /home/michael/etrade-trade-placer
  git add scripts/promote-ryansoldmac.sh scripts/promote-alienware.sh docs/failover.md
  git commit -m "Add failover scripts (promote-{ryansoldmac,alienware}) + runbook"
  git push origin main
  ```
- [ ] **Step 2: Trigger ryansoldmac's hourly git-pull manually so the new files exist there for the dry run.**
  ```bash
  ssh clawd@ryansoldmac 'cd /Users/michael/Documents/2026/projects/etrade-trade-placer && git pull && ls scripts/promote-*.sh docs/failover.md'
  ```

---

## Phase 9: Failover dry run

This is the only test that proves the runbook actually works end-to-end.

### Task 9.1: Promote ryansoldmac

**Files:** none

- [ ] **Step 1: Run the script.** From the operator's local Mac:
  ```bash
  ssh michael@alienware-r8 'cat /home/michael/etrade-trade-placer/scripts/promote-ryansoldmac.sh' | bash
  ```
- [ ] **Step 2: Verify Caddy points at ryansoldmac.**
  ```bash
  ssh ctdsu.com 'grep reverse_proxy /etc/caddy/Caddyfile | grep 3102'
  ```
  Expected: `100.64.0.7`.
- [ ] **Step 3: End-to-end check.**
  ```bash
  curl -sS -o /dev/null -w '%{http_code}\n' -X POST -H 'x-webhook-secret: wrong' https://relay.ctdsu.com/
  ssh clawd@ryansoldmac 'curl -s http://127.0.0.1:3001/health'
  ```
  Expected: `401` and a healthy JSON body.

### Task 9.2: Promote alienware (revert)

- [ ] **Step 1: Run the mirror script.** From the operator's local Mac:
  ```bash
  ssh michael@alienware-r8 'cat /home/michael/etrade-trade-placer/scripts/promote-alienware.sh' | bash
  ```
- [ ] **Step 2: Verify Caddy and health on alienware.**
  ```bash
  ssh ctdsu.com 'grep reverse_proxy /etc/caddy/Caddyfile | grep 3102'
  ssh michael@alienware-r8 'curl -s http://127.0.0.1:3001/health'
  ```
  Expected: `100.64.0.11` and healthy JSON.

### Task 9.3: Confirm cron states

- [ ] **Step 1: Alienware morning cron is active**, ryansoldmac's is commented:
  ```bash
  ssh michael@alienware-r8 'crontab -l | grep etrade-morning'
  # expect: a non-commented line
  ssh clawd@ryansoldmac 'crontab -l | grep etrade-morning'
  # expect: line prefixed with "# STANDBY"
  ```

---

## Phase 10: Final verification and project commit

### Task 10.1: Verify all the pieces

- [ ] **Step 1: Active host clean.**
  ```bash
  ssh michael@alienware-r8 '
    systemctl is-active etrade-server etrade-scheduler etrade-frontend etrade-otp-relay
    crontab -l | grep -E "etrade-morning|dump-db"
  '
  ```
  Expected: 4× `active`, 2 cron lines.
- [ ] **Step 2: Standby host clean.**
  ```bash
  ssh clawd@ryansoldmac '
    screen -ls 2>&1 | head
    crontab -l | grep -E "etrade|git pull|sync-from"
  '
  ```
  Expected: no etrade screens, morning line commented, hourly-pull and nightly-sync lines present.
- [ ] **Step 3: Caddy stable.** `ssh ctdsu.com 'systemctl status caddy --no-pager | head -5'` shows `active (running)`.
- [ ] **Step 4: Webhook chain.**
  ```bash
  curl -sS -o /dev/null -w '%{http_code}\n' -X POST -H 'x-webhook-secret: wrong' https://relay.ctdsu.com/
  ```
  Expected: `401`.

### Task 10.2: Mark this plan as done in the project

- [ ] **Step 1: Move/rename the plan file** to indicate completion (or just leave it — the `git log` of the implementation commits is the real audit trail). If you want to mark it explicitly:
  ```bash
  cd /home/michael/etrade-trade-placer
  git mv docs/superpowers/plans/2026-04-25-migrate-to-alienware.md \
         docs/superpowers/plans/2026-04-25-migrate-to-alienware.DONE.md
  git commit -m "Mark migrate-to-alienware plan as done"
  git push origin main
  ```

---

## Self-review

**Spec coverage** — every requirement from the original ask:

- "Transfer this app, completely, to the alienware" → Phases 1–6 (install, copy code, migrate DB, move services, cutover).
- "Ryansoldmac should have the ability to pick it up at a moment's notice" → Phase 7 (warm standby with hourly git + nightly DB sync) and Phase 8 (`promote-ryansoldmac.sh` + runbook).
- "Should have all the instructions" → `docs/failover.md` (committed to repo, so present on both hosts).
- "Actual orders running from the alienware" → Phases 3–6 land all four services on alienware as the only place the morning cron and scheduler run.

**Placeholder scan** — all task code blocks contain literal commands, paths, and unit contents. No "TBD", "fill in details", or "similar to Task N" — each script is fully written out.

**Type/name consistency** — service names (`etrade-server`, `etrade-scheduler`, `etrade-frontend`, `etrade-otp-relay`) used identically across systemd unit definitions, smoke tests, failover scripts, runbook, and verification phase. Tailscale IPs (`100.64.0.7` for ryansoldmac, `100.64.0.11` for alienware) consistent across Caddy edits in cutover and both promote scripts.

## Notes / risks / out-of-scope

- **In-flight order reconciliation script** is mentioned in the runbook but not built in this plan. Tracking as backlog: a script that calls `getOrderStatus` against E\*TRADE for each order with `submittedAt > <failover-time>` and reconciles DB state.
- **TCC on ryansoldmac** is no longer in the critical path (since standby doesn't run cron) but the morning script's macOS branch still depends on it for failover. Granted as of 2026-04-25; document re-grants needed after macOS upgrades.
- **Single Caddy SPOF** — if the Hetzner VPS goes down, neither host is reachable from Apps Script even though both are healthy locally. Not addressed here; would need DNS-level failover or a second relay.
- **DB sync uses pg_dump (logical)**, not WAL streaming. Tightening RPO below 24 h means bumping cron frequency, which is trivial. Switching to physical streaming is the next-tier change if RPO needs to be sub-hour.
