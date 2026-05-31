#!/usr/bin/env bash
# Pull the latest pg_dump from the primary (alienware) and restore into a
# parallel database `etrade_trader_standby` so the live `etrade_trader` on
# the standby (ryansoldmac) is left untouched while in standby mode.
#
# The actual rename/swap to live happens during failover via
# scripts/promote-ryansoldmac.sh, which restores into `etrade_trader`
# directly from a fresh dump.
#
# Designed to run from ryansoldmac's nightly cron (23:30 ET, after
# alienware's 22:30 dump completes). See docs/failover.md.
set -euo pipefail

PRIMARY_HOST="${PRIMARY_HOST:-michael@alienware-r8}"
PRIMARY_DUMP_PATH="${PRIMARY_DUMP_PATH:-/var/backups/etrade/latest.dump}"
BACKUP_DIR="${BACKUP_DIR:-/Users/clawd/var/etrade-backups}"
STANDBY_DB="${STANDBY_DB:-etrade_trader_standby}"
DB_USER="${DB_USER:-michael}"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$BACKUP_DIR/etrade-$STAMP.dump"

mkdir -p "$BACKUP_DIR"

# Pull the dump over SSH. Use a tmp file + atomic rename so a failed pull
# never replaces the previous good copy.
ssh "$PRIMARY_HOST" "cat $PRIMARY_DUMP_PATH" > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"
ln -sfn "$OUT" "$BACKUP_DIR/latest.dump"

# Restore into a parallel DB so live `etrade_trader` stays clean during standby.
sudo -u "$DB_USER" psql -c "DROP DATABASE IF EXISTS $STANDBY_DB" postgres
sudo -u "$DB_USER" psql -c "CREATE DATABASE $STANDBY_DB" postgres
sudo -u "$DB_USER" pg_restore --no-owner --no-acl -d "$STANDBY_DB" "$OUT"

# Retention: 14 days
find "$BACKUP_DIR" -name 'etrade-*.dump' -mtime +14 -delete

# stat -f for BSD (macOS), -c for GNU (Linux); fall back gracefully.
SIZE=$(stat -f %z "$OUT" 2>/dev/null || stat -c %s "$OUT")
echo "[$(date -u +%FT%TZ)] synced $SIZE bytes from $PRIMARY_HOST -> $STANDBY_DB"
