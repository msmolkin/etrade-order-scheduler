#!/usr/bin/env bash
# E*TRADE morning startup script
# Run by cron at 6:25 AM weekdays to ensure everything is up,
# then authenticate and run market scripts.
set -euo pipefail

# --- Platform detection: choose service-management primitives ---
if [[ "$(uname -s)" == "Linux" ]]; then
  start_service()   { sudo systemctl start "etrade-$1"; }
  restart_service() { sudo systemctl restart "etrade-$1"; }
  stop_service()    { sudo systemctl stop "etrade-$1" 2>/dev/null || true; }
  is_running()      { systemctl is-active --quiet "etrade-$1"; }
else
  # macOS / ryansoldmac legacy path: each service runs in a named screen.
  # The second arg is the exec command; only used by start_service.
  start_service() {
    local name=$1 cmd=$2
    screen -dmS "etrade-$name" bash -c "cd $PROJECT_DIR && source .env && export \$(grep -v '^#' .env | xargs) && exec $cmd >> /tmp/etrade-$name.log 2>&1"
  }
  restart_service() { stop_service "$1"; sleep 1; start_service "$@"; }
  stop_service() {
    screen -S "etrade-$1" -X quit 2>/dev/null || true
    case "$1" in
      server)    pkill -f 'src/server/index.ts' 2>/dev/null || true ;;
      scheduler) pkill -f 'local-scheduler' 2>/dev/null || true ;;
      frontend)  pkill -f 'vite --host' 2>/dev/null || true ;;
      otp-relay) pkill -f 'otp-webhook-relay' 2>/dev/null || true ;;
    esac
  }
  is_running() { screen -ls 2>/dev/null | grep -q "etrade-$1"; }
fi

# Allow scripts that source this file (tests) to skip the actual run.
[[ -n "${ETRADE_MORNING_DRY_RUN:-}" ]] && return 0 2>/dev/null

if [[ "$(uname -s)" == "Linux" ]]; then
  PROJECT_DIR="/home/michael/etrade-trade-placer"
  NPX="/home/michael/.nvm/versions/node/v24.13.0/bin/npx"
  export PATH="/home/michael/.nvm/versions/node/v24.13.0/bin:$PATH"
else
  PROJECT_DIR="/Users/michael/Documents/2026/projects/etrade-trade-placer"
  NPX="/Users/clawd/.nvm/versions/node/v24.13.0/bin/npx"
  export PATH="/Users/clawd/.nvm/versions/node/v24.13.0/bin:$PATH"
fi

cd "$PROJECT_DIR"

# Load .env
set -a
source .env 2>/dev/null || true
set +a

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# --- Phase 1: Ensure services are running ---

# Server (API on port 3001) — use screen so it survives
if ! is_running server; then
  log "Starting server..."
  start_service server "$NPX tsx src/server/index.ts"
  sleep 10
  if curl -sS http://127.0.0.1:3001/health > /dev/null 2>&1; then
    log "Server started."
  else
    log "ERROR: Server failed to start. Check /tmp/etrade-app.log"
  fi
else
  log "Server already running."
fi

# Frontend (Vite on port 3000) — use screen so it survives
if ! is_running frontend; then
  log "Starting frontend..."
  start_service frontend "$NPX vite --host --port 3000"
  sleep 5
  if curl -sS http://127.0.0.1:3000/ > /dev/null 2>&1; then
    log "Frontend started."
  else
    log "ERROR: Frontend failed to start. Check /tmp/etrade-vite.log"
  fi
else
  log "Frontend already running."
fi

# Scheduler
if ! is_running scheduler; then
  log "Starting scheduler..."
  start_service scheduler "$NPX tsx src/scheduler/local-scheduler.ts"
  sleep 3
  log "Scheduler started."
else
  log "Scheduler already running."
fi

# --- Phase 2: Authenticate (wait for OTP relay) ---
log "Triggering E*TRADE auth..."
AUTH_RESULT=$(curl -sS -X POST http://127.0.0.1:3001/api/auth/auto \
  -H 'Content-Type: application/json' \
  -d '{"headless":true,"clearCookies":true}' 2>&1)
log "Auth result: $AUTH_RESULT"

# Give time for the OTP to arrive via Apps Script (up to 3 min)
sleep 180

# --- Phase 2b: Restart server + scheduler to pick up refreshed tokens ---
# The app writes new tokens to .env, but its long-running processes keep the
# old tokens in memory — every subsequent order returns oauth_problem=token_rejected
# until they reload.
log "Restarting server + scheduler to reload .env..."
restart_service server "$NPX tsx src/server/index.ts"
for i in $(seq 1 20); do
  if curl -sS http://127.0.0.1:3001/health > /dev/null 2>&1; then
    log "Server back up."
    break
  fi
  sleep 2
done
if ! curl -sS http://127.0.0.1:3001/health > /dev/null 2>&1; then
  log "ERROR: Server did not return to health after restart. Check /tmp/etrade-app.log"
fi

restart_service scheduler "$NPX tsx src/scheduler/local-scheduler.ts"
sleep 3
log "Scheduler restarted."

# --- Phase 3: Market data scripts ---
log "Logging Micron quote..."
"$NPX" tsx src/scripts/get-micron-quote.ts >> /tmp/etrade-micron.log 2>&1 || log "Micron quote failed"

log "Logging INTC options..."
"$NPX" tsx src/scripts/schedule-intc-option-orders.ts >> /tmp/etrade-intc-options.log 2>&1 || log "INTC options failed"

log "Morning startup complete."
