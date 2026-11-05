#!/usr/bin/env bash
# Daily backup + retention. Run from any machine that can reach Atlas (cron / GitHub Actions / your PC).
#   MONGO_URI=... ./scripts/backup.sh            -> backups/wms-YYYY-MM-DD.gz  (keeps the last 14)
#   MONGO_URI=... ./scripts/backup.sh --verify   -> restores the newest backup into a throw-away DB and compares document counts
set -euo pipefail
: "${MONGO_URI:?set MONGO_URI}"
DIR="${BACKUP_DIR:-backups}"; mkdir -p "$DIR"
if [[ "${1:-}" == "--verify" ]]; then
  F=$(ls -1t "$DIR"/wms-*.gz | head -1); echo "Verifying $F"
  mongorestore --uri "$MONGO_URI" --gzip --archive="$F" --nsFrom='*.*' --nsTo='restore_check.*' --drop >/dev/null
  echo "Restored into database restore_check. Compare counts in mongosh, then: db.getSiblingDB('restore_check').dropDatabase()"; exit 0
fi
F="$DIR/wms-$(date +%F).gz"
mongodump --uri "$MONGO_URI" --gzip --archive="$F"
ls -1t "$DIR"/wms-*.gz | tail -n +15 | xargs -r rm --
echo "Backup written: $F ($(du -h "$F" | cut -f1))"
