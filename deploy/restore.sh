#!/bin/sh
# Puts a backup back: the database and the uploaded documents, from the same night.
# Everything in the live database is replaced. Run from deploy/, on the server:
#
#   ./restore.sh backups/db-2026-10-28T0030Z.dump backups/storage-2026-10-28T0030Z.tar.gz
#
# A copy kept off the server goes in backups/ first (rclone copy offsite:... backups/).
set -eu
cd "$(dirname "$0")"
DUMP="${1:?which database dump?}"
FILES="${2:?which storage archive?}"
[ -f "$DUMP" ] && [ -f "$FILES" ] || { echo "Both files must be under deploy/backups/."; exit 1; }
compose="docker compose --env-file .env.production"

printf 'This replaces everything in the live database with %s. Type RESTORE to go on: ' "$DUMP"
read -r answer
[ "$answer" = "RESTORE" ] || { echo "Stopped."; exit 1; }

echo "Stopping the app so nothing writes while the data is replaced."
$compose stop app
$compose exec -T backup sh -c "dropdb --if-exists tms_previous && psql -d postgres -c 'alter database tms rename to tms_previous' && createdb tms"
$compose exec -T backup pg_restore --no-owner --dbname=tms "/backups/$(basename "$DUMP")"
$compose run --rm --no-deps -T --user root --entrypoint sh app -c \
  "rm -rf /data/storage/* && tar -xzf /backups/$(basename "$FILES") -C /data && chown -R node:node /data/storage"
$compose start app
echo "Restored. The database as it was before is kept as tms_previous; drop it once all is well:"
echo "  $compose exec backup dropdb tms_previous"
