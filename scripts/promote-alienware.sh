#!/usr/bin/env bash
# Failover: promote alienware from standby to primary (reverse direction).
#
# Run from operator's local Mac (or any host with SSH access to all three:
# clawd@ryansoldmac, michael@alienware-r8, ctdsu.com).
#
# Mirror of promote-ryansoldmac.sh. Idempotent / safe to re-run.
#
# After this script: ryansoldmac is standby (screens stopped), alienware
# is primary (systemd services running, Caddy pointing at 100.64.0.11:3102).
# You still need to:
#   - re-enable morning cron on alienware
#   - comment out morning cron on ryansoldmac
# See docs/failover.md for the post-promote checklist.

set -euo pipefail

ALIENWARE_IP=100.64.0.11
RYANSOLDMAC_IP=100.64.0.7

echo "==> 1/6: Stopping etrade screens on ryansoldmac (current primary)"
ssh clawd@ryansoldmac '
  for svc in etrade-server etrade-scheduler etrade-frontend etrade-otp-relay; do
    screen -S "$svc" -X quit 2>/dev/null || true
  done
  pkill -f "src/server/index.ts" 2>/dev/null || true
  pkill -f "local-scheduler" 2>/dev/null || true
  pkill -f "vite --host" 2>/dev/null || true
  pkill -f "otp-webhook-relay" 2>/dev/null || true
  sleep 2
  screen -ls 2>&1 | grep -E "etrade-" || echo "    no etrade screens"
  lsof -iTCP -sTCP:LISTEN -n -P 2>/dev/null | grep -E ":300[01]|:3102" || echo "    ports clear"
'

echo "==> 2/6: Final pg_dump on ryansoldmac"
ssh clawd@ryansoldmac '
  sudo -u michael pg_dump -Fc etrade_trader > /tmp/etrade-failover.dump
  ls -lh /tmp/etrade-failover.dump
'

echo "==> 3/6: Streaming dump to alienware and restoring to live etrade_trader"
ssh clawd@ryansoldmac 'cat /tmp/etrade-failover.dump' | \
  ssh michael@alienware-r8 'cat > /tmp/etrade-failover.dump'
ssh michael@alienware-r8 '
  ls -lh /tmp/etrade-failover.dump
  pg_restore --clean --if-exists --no-owner --no-acl \
    -d etrade_trader /tmp/etrade-failover.dump 2>&1 | tail -5
  psql etrade_trader -tAc "SELECT count(*) FROM orders"
'

echo "==> 4/6: Starting systemd services on alienware"
ssh michael@alienware-r8 '
  sudo systemctl start etrade-otp-relay etrade-scheduler etrade-frontend
  sleep 8
  systemctl is-active etrade-server etrade-scheduler etrade-frontend etrade-otp-relay || true
'

echo "==> 5/6: Re-pointing Caddy at alienware (${ALIENWARE_IP}:3102)"
ssh ctdsu.com "
  set -euo pipefail
  if grep -qE 'reverse_proxy ${ALIENWARE_IP}:3102' /etc/caddy/Caddyfile; then
    echo '    Caddy already points at alienware — no change'
  else
    sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.\$(date -u +%Y%m%dT%H%M%SZ)
    sudo sed -i 's|reverse_proxy ${RYANSOLDMAC_IP}:3102|reverse_proxy ${ALIENWARE_IP}:3102|' /etc/caddy/Caddyfile
    sudo caddy validate --config /etc/caddy/Caddyfile
    sudo systemctl reload caddy
    grep -E 'reverse_proxy 100\\.64\\.0\\.[0-9]+:3102' /etc/caddy/Caddyfile
  fi
"

echo "==> 6/6: Smoke test"
sleep 3
PUBLIC=$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'x-webhook-secret: wrong' https://relay.ctdsu.com/ || echo curl_failed)
echo "    public relay: http=${PUBLIC} (401 = healthy)"
ssh michael@alienware-r8 'curl -s http://127.0.0.1:3001/health 2>&1 | head -2 || echo "    LOCAL HEALTH FAILED — check journalctl -u etrade-server"'

cat <<'POST'

==> Failover to alienware complete.

Next steps (manual):
  1. Re-enable morning cron on alienware (if currently commented):
       ssh michael@alienware-r8 'crontab -l | sed -E "s|^# STANDBY - re-enable on failover: ||" | crontab -'
  2. Disable morning cron on ryansoldmac:
       ssh clawd@ryansoldmac 'crontab -l | sed -E "s|^(0 3 \* \* 1-5 .*etrade-morning\.sh.*)|# STANDBY - re-enable on failover: \1|" | crontab -'
  3. Verify:
       ssh ctdsu.com 'grep reverse_proxy /etc/caddy/Caddyfile | grep 3102'   # expect 100.64.0.11
POST
