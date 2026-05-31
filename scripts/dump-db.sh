#!/usr/bin/env bash
# Daily pg_dump for the standby to pull. Rotates older than 14 days.
# Lives at /var/backups/etrade/. The latest dump is also reachable via
# /var/backups/etrade/latest.dump (symlink).
set -euo pipefail

BACKUP_DIR=/var/backups/etrade
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$BACKUP_DIR/etrade-$STAMP.dump"

sudo install -d -o michael -g michael "$BACKUP_DIR"
pg_dump -Fc etrade_trader > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"
ln -sfn "$OUT" "$BACKUP_DIR/latest.dump"

# Retention: keep last 14 days
find "$BACKUP_DIR" -name 'etrade-*.dump' -mtime +14 -delete

echo "[$(date -u +%FT%TZ)] dumped $(stat -c %s "$OUT") bytes -> $OUT"
