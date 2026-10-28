#!/bin/sh
# Nightly backups: the database (pg_dump, custom format) and the uploaded documents, together,
# because a lease row without its signed PDF is half a record. Kept BACKUP_KEEP_DAYS days here
# and, with BACKUP_REMOTE set, copied off this server with rclone, which is what makes them a
# backup rather than a second copy on the same disk.
#
#   sh /backup.sh now      one backup immediately
#   sh /backup.sh check    restore the newest dump into a scratch database and compare counts
set -eu
# Backups hold tenants' personal information: readable by their owner only.
umask 077

KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
# 00:30 UTC is 02:30 in Johannesburg (no daylight saving), before the morning jobs run.
AT_UTC="${BACKUP_AT_UTC:-00:30}"
DIR=/backups

log() { echo "$(date -u +%FT%TZ) backup: $*"; }

offsite() {
  [ -n "${BACKUP_REMOTE:-}" ] || return 0
  command -v rclone >/dev/null 2>&1 || apk add --no-cache rclone >/dev/null
  rclone copy "$DIR" "$BACKUP_REMOTE" --include 'db-*.dump' --include 'storage-*.tar.gz' --max-age 48h
  log "copied to $BACKUP_REMOTE"
}

backup() {
  stamp="$(date -u +%Y-%m-%dT%H%MZ)"
  pg_dump --format=custom --file="$DIR/db-$stamp.dump.partial"
  # A dump that pg_restore cannot list is not a backup.
  pg_restore --list "$DIR/db-$stamp.dump.partial" >/dev/null
  mv "$DIR/db-$stamp.dump.partial" "$DIR/db-$stamp.dump"
  tar -czf "$DIR/storage-$stamp.tar.gz.partial" -C /data storage
  mv "$DIR/storage-$stamp.tar.gz.partial" "$DIR/storage-$stamp.tar.gz"
  find "$DIR" -name 'db-*.dump' -mtime +"$KEEP_DAYS" -delete
  find "$DIR" -name 'storage-*.tar.gz' -mtime +"$KEEP_DAYS" -delete
  offsite
  # The app's health check reads this file's age: no fresh backup, no green light.
  date -u +%FT%TZ > "$DIR/last-ok"
  log "done: db-$stamp.dump, storage-$stamp.tar.gz"
}

check() {
  newest="$(ls -1t "$DIR"/db-*.dump 2>/dev/null | head -n 1)"
  [ -n "$newest" ] || { log "no dump to check"; exit 1; }
  log "restoring $newest into tms_restore_check"
  dropdb --if-exists tms_restore_check
  createdb tms_restore_check
  pg_restore --no-owner --dbname=tms_restore_check "$newest"
  failed=0
  for table in landlord property unit lease invoice payment deposit_ledger audit_log; do
    live="$(psql -At -c "select count(*) from $table")"
    restored="$(psql -At -d tms_restore_check -c "select count(*) from $table")"
    echo "  $table: live $live, restored $restored"
    # The live database may have grown since the dump; it must never have fewer rows than it.
    [ "$restored" -le "$live" ] || failed=1
    [ "$restored" -gt 0 ] || [ "$live" -eq 0 ] || failed=1
  done
  dropdb tms_restore_check
  [ "$failed" -eq 0 ] && log "restore check passed" || { log "restore check FAILED"; exit 1; }
}

case "${1:-loop}" in
  now) backup; exit 0 ;;
  check) check; exit 0 ;;
esac

# First start, or a server that was off overnight: back up now if the last one is a day old.
if [ ! -f "$DIR/last-ok" ] || [ -n "$(find "$DIR/last-ok" -mmin +1440)" ]; then backup || log "backup failed"; fi
while true; do
  now="$(date -u +%s)"
  next="$(date -u -d "$(date -u +%F) $AT_UTC" +%s 2>/dev/null || date -u -D '%Y-%m-%d %H:%M' -d "$(date -u +%F) $AT_UTC" +%s)"
  [ "$next" -gt "$now" ] || next=$((next + 86400))
  sleep $((next - now))
  backup || log "backup failed; the health check turns red after 36 hours without one"
done
