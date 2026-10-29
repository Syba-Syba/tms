#!/bin/sh
# Puts a backup back: the database and the uploaded documents, from the same night.
# Everything in the live database is replaced. Run from deploy/, on the server:
#
#   ./restore.sh backups/db-2026-10-28T0030Z.dump backups/storage-2026-10-28T0030Z.tar.gz
#
# A copy kept off the server goes in backups/ first (rclone copy offsite:... backups/).
# If any step fails after the database is renamed, the database and the documents are put back
# as they were and the app is started again.
set -eu
cd "$(dirname "$0")"
DUMP="${1:?which database dump?}"
FILES="${2:?which storage archive?}"
compose() { docker compose --env-file .env.production "$@"; }
# A one-off container of the backup service: it has psql, the database socket and /backups,
# and works while the service itself is stopped.
pgsh() { compose run --rm --no-deps -T --entrypoint sh backup -c "$1"; }
# A one-off container of the app, as root, with the documents volume at /data/storage.
appsh() { compose run --rm --no-deps -T --user root --entrypoint sh app -c "$1"; }

# The containers see deploy/backups/ as /backups, so both files must be directly in it.
backups="$(realpath -e backups 2>/dev/null)" || { echo "There is no deploy/backups/ directory."; exit 1; }
for f in "$DUMP" "$FILES"; do
  real="$(realpath -e -- "$f" 2>/dev/null)" || { echo "No such file: $f"; exit 1; }
  if [ ! -f "$real" ] || [ "$(dirname "$real")" != "$backups" ]; then
    echo "$f is $real, which is not a file directly in $backups/. Copy it there first."
    exit 1
  fi
  case "$(basename "$real")" in
    *[!A-Za-z0-9._-]*) echo "$f: rename it to letters, digits, '.', '_' and '-' only."; exit 1 ;;
  esac
done
dump="$(basename "$(realpath -- "$DUMP")")"
files="$(basename "$(realpath -- "$FILES")")"

echo "Checking both files can be read before anything is stopped."
pgsh "pg_restore --list /backups/$dump >/dev/null" || { echo "$dump is not a readable dump. Nothing was changed."; exit 1; }
appsh "tar -tzf /backups/$files >/dev/null && test ! -e /data/storage/.restore-prev" || {
  echo "$files is not a readable archive, or /data/storage/.restore-prev from an earlier restore"
  echo "is still there (remove it once that restore is confirmed good). Nothing was changed."
  exit 1
}

printf 'This replaces everything in the live database with %s. Type RESTORE to go on: ' "$dump"
read -r answer
[ "$answer" = "RESTORE" ] || { echo "Stopped."; exit 1; }

db_renamed=0
storage_done=0
finished=0
rollback() {
  status=$?
  [ "$finished" -eq 1 ] && return 0
  trap - EXIT INT TERM
  set +e
  echo
  echo "RESTORE FAILED (exit $status). Putting everything back as it was."
  if [ "$db_renamed" -eq 1 ]; then
    if pgsh "dropdb --if-exists tms && psql -d postgres -c 'alter database tms_previous rename to tms'"; then
      echo "  Database: the original is back as tms."
    else
      echo "  Database: COULD NOT PUT IT BACK. The original is tms_previous; once the cause is fixed:"
      echo "    docker compose --env-file .env.production run --rm --no-deps -T --entrypoint sh backup -c \\"
      echo "      \"dropdb --if-exists tms && psql -d postgres -c 'alter database tms_previous rename to tms'\""
    fi
  fi
  # Only touches files when a swap began (.restore-state); otherwise just removes the extract.
  if appsh "cd /data/storage && state=\$(cat .restore-state 2>/dev/null || echo none)
    if [ \$state = new-in ] || [ $storage_done -eq 1 ]; then
      find . -mindepth 1 -maxdepth 1 ! -name .restore-prev -exec rm -rf -- {} +
    elif [ \$state = old-out ]; then
      find . -mindepth 1 -maxdepth 1 ! -name .restore-prev ! -name .restore-new ! -name .restore-state -exec mv -t .restore-prev -- {} +
    fi
    rm -rf .restore-new .restore-state
    if [ -d .restore-prev ]; then
      find .restore-prev -mindepth 1 -maxdepth 1 -exec mv -t . -- {} + && rmdir .restore-prev
    fi"; then
    echo "  Documents: the originals are back."
  else
    echo "  Documents: COULD NOT PUT THEM BACK. Originals are in /data/storage/.restore-prev in the storage volume."
  fi
  compose start app backup && echo "  The app is running again on the data it had before."
  exit "$status"
}
trap rollback EXIT
trap 'exit 130' INT TERM

echo "Stopping the app and backups so nothing writes while the data is replaced."
compose stop app backup
pgsh "dropdb --if-exists tms_previous"
pgsh "psql -d postgres -c 'alter database tms rename to tms_previous'"
db_renamed=1
pgsh "createdb tms"
pgsh "pg_restore --no-owner --single-transaction --exit-on-error --dbname=tms /backups/$dump"

# Documents: extract beside the live ones, then swap by renaming within the volume. The old
# ones are kept in .restore-prev. .restore-state records how far the swap got.
appsh "set -e; cd /data/storage
  rm -rf .restore-new; mkdir .restore-new .restore-prev
  tar -xzf /backups/$files -C .restore-new
  test -d .restore-new/storage
  chown -R node:node .restore-new/storage
  echo old-out > .restore-state
  find . -mindepth 1 -maxdepth 1 ! -name .restore-prev ! -name .restore-new ! -name .restore-state -exec mv -t .restore-prev -- {} +
  echo new-in > .restore-state
  find .restore-new/storage -mindepth 1 -maxdepth 1 -exec mv -t . -- {} +
  rm -rf .restore-new .restore-state"
storage_done=1

compose start app backup
finished=1
echo "Restored. What was there before is kept until you are sure all is well:"
echo "  database:  tms_previous     drop it with: docker compose --env-file .env.production exec backup dropdb tms_previous"
echo "  documents: .restore-prev    remove it with: docker compose --env-file .env.production run --rm --no-deps --user root --entrypoint rm app -rf /data/storage/.restore-prev"
echo "Until .restore-prev is removed, nightly backups include it (twice the size)."
