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
  mongosh "$MONGO_URI" --quiet <<'MONGOSH'
const sourceDbNames = db.getMongo().getDBNames();
const sourceDbName = sourceDbNames.find((name) => name !== "restore_check");
if (!sourceDbName) {
  throw new Error("Could not identify the source database");
}
const source = db.getSiblingDB(sourceDbName);
const restored = db.getSiblingDB("restore_check");
let mismatch = false;
for (const collectionName of source.getCollectionNames()) {
  const sourceCount = source.getCollection(collectionName).countDocuments({});
  const restoredCount = restored.getCollection(collectionName).countDocuments({});
  print(`${collectionName}: source=${sourceCount} restored=${restoredCount}`);
  if (sourceCount !== restoredCount) mismatch = true;
}
if (mismatch) throw new Error("Backup verification failed: collection counts do not match");
restored.dropDatabase();
print("Backup verification passed");
MONGOSH
  exit 0
fi
F="$DIR/wms-$(date +%F).gz"
mongodump --uri "$MONGO_URI" --gzip --archive="$F"
ls -1t "$DIR"/wms-*.gz | tail -n +15 | xargs -r rm --
echo "Backup written: $F ($(du -h "$F" | cut -f1))"
