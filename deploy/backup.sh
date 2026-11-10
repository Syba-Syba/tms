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
DIR="${BACKUP_DIR:-/backups}"

log() { echo "$(date -u +%FT%TZ) backup: $*"; }

# Every erasure ever made, one line each: epoch|key|person|landlord (lib/privacy.ts,
# parseErasureList). Ids only, no names. restore.sh replays them, so restoring a dump older than
# an erasure, even on a new server, does not bring the person back. Same query in restore.sh.
ERASURES_SQL="select extract(epoch from at)::bigint, coalesce(detail->>'replayOf', id::text || '@' || to_char(at at time zone 'UTC', 'YYYYMMDDHH24MISSUS')), detail->>'personSub', coalesce(detail->>'landlordId', '') from audit_log where action = 'privacy.erased' and detail ? 'personSub' order by at"

# Every step below ends in `|| return 1`: backup is called as `backup || log ...`, and on the
# left of || POSIX sh ignores set -e inside the function, so a failed step would otherwise carry
# on and still write last-ok.
offsite() {
  [ -n "${BACKUP_REMOTE:-}" ] || return 0
  command -v rclone >/dev/null 2>&1 || apk add --no-cache rclone >/dev/null || return 1
  rclone copy "$DIR" "$BACKUP_REMOTE" --include 'db-*.dump' --include 'storage-*.tar.gz' --include erasures.txt --max-age 48h || return 1
  # The copies off the server are kept as long as the ones here, and no longer.
  rclone delete "$BACKUP_REMOTE" --include 'db-*.dump' --include 'storage-*.tar.gz' --min-age "${KEEP_DAYS}d" || return 1
  log "copied to $BACKUP_REMOTE, pruned copies there older than $KEEP_DAYS days"
}

backup() {
  # BACKUP_* and RCLONE_CONFIG_* moved to backup.env. Left in .env.production they no longer
  # reach this container, and a server that had a remote would quietly keep its backups only
  # here. So no backup counts until they are moved.
  if [ -n "${LEGACY_BACKUP_REMOTE:-}" ] && [ -z "${BACKUP_REMOTE:-}" ]; then
    log "FAILED: BACKUP_REMOTE is set in .env.production, which this container no longer reads. Move BACKUP_* and RCLONE_CONFIG_* to deploy/backup.env (see README, Updating)."
    return 1
  fi
  stamp="$(date -u +%Y-%m-%dT%H%MZ)" || return 1
  db="$DIR/db-$stamp.dump"
  files="$DIR/storage-$stamp.tar.gz"
  # Left behind by a backup that died part-way.
  find "$DIR" -name '*.partial' -mmin +1440 -delete || return 1
  pg_dump --format=custom --file="$db.partial" || { log "FAILED: pg_dump"; rm -f "$db.partial"; return 1; }
  # A dump that pg_restore cannot list is not a backup.
  pg_restore --list "$db.partial" >/dev/null || { log "FAILED: pg_restore cannot read $db.partial"; return 1; }
  mv "$db.partial" "$db" || { log "FAILED: mv $db"; return 1; }
  # What a restore leaves beside the documents is not part of them: a backup that held
  # .restore-prev could not itself be restored (restore.sh moves the live files there).
  tar -czf "$files.partial" -C /data --exclude=storage/.restore-prev --exclude=storage/.restore-new \
    --exclude=storage/.restore-state storage || { log "FAILED: tar of /data/storage"; rm -f "$files.partial"; return 1; }
  mv "$files.partial" "$files" || { log "FAILED: mv $files"; return 1; }
  # Not pruned with the dumps: an erasure must outlive every backup taken before it.
  psql -At -F '|' -v ON_ERROR_STOP=1 -c "$ERASURES_SQL" > "$DIR/erasures.txt.partial" \
    || { log "FAILED: listing erasures"; rm -f "$DIR/erasures.txt.partial"; return 1; }
  mv "$DIR/erasures.txt.partial" "$DIR/erasures.txt" || { log "FAILED: mv erasures.txt"; return 1; }
  find "$DIR" -name 'db-*.dump' -mtime +"$KEEP_DAYS" -delete || return 1
  find "$DIR" -name 'storage-*.tar.gz' -mtime +"$KEEP_DAYS" -delete || return 1
  if ! offsite; then
    # The dump here is good and kept, but a backup only on this server is not a backup: no
    # last-ok, so /health turns red and someone looks.
    log "FAILED: OFFSITE COPY TO $BACKUP_REMOTE FAILED. db-$stamp.dump and storage-$stamp.tar.gz are kept here only; last-ok not updated"
    return 1
  fi
  # The app's health check reads this file's age: no fresh backup, no green light.
  date -u +%FT%TZ > "$DIR/last-ok" || return 1
  log "done: db-$stamp.dump, storage-$stamp.tar.gz"
}

check() {
  # Stamps sort by name, so the last is the newest.
  newest="$(find "$DIR" -maxdepth 1 -name 'db-*.dump' | sort | tail -n 1)"
  [ -n "$newest" ] || { log "no dump to check"; exit 1; }
  log "restoring $newest into tms_restore_check"
  dropdb --if-exists tms_restore_check
  createdb tms_restore_check
  # --no-acl: the grants name the owner's roles, which this read-only role may not hand out.
  pg_restore --no-owner --no-acl --exit-on-error --dbname=tms_restore_check "$newest"
  failed=0
  for table in landlord property unit lease invoice payment deposit_ledger audit_log; do
    # The privacy sweep deletes failed sign-ins older than 90 days from audit_log after the
    # dump, so those are left out of its count; everything else in it only grows.
    count="select count(*) from $table"
    [ "$table" = audit_log ] && count="$count where action <> 'auth.login_failed'"
    live="$(psql -At -c "$count")"
    restored="$(psql -At -d tms_restore_check -c "$count")"
    echo "  $table: live $live, restored $restored"
    case "$table" in
      # A landlord may delete a property or unit after the dump, so the live count can drop.
      property | unit) ;;
      # These only grow: the live database must never have fewer rows than the dump.
      *) [ "$restored" -le "$live" ] || failed=1 ;;
    esac
    [ "$restored" -gt 0 ] || [ "$live" -eq 0 ] || failed=1
  done
  dropdb tms_restore_check
  if [ "$failed" -eq 0 ]; then log "restore check passed"; else log "restore check FAILED"; exit 1; fi
}

# The app creates this role when it starts, which may be after this container does.
waited=0
until psql -Atc 'select 1' >/dev/null 2>&1; do
  [ "$waited" -eq 0 ] && log "waiting for the database and the $PGUSER role (the app creates it on start)"
  waited=$((waited + 5))
  [ "$waited" -lt 900 ] || { log "FAILED: cannot connect as $PGUSER after 15 minutes"; exit 1; }
  sleep 5
done

case "${1:-loop}" in
  now) backup || { log "backup FAILED"; exit 1; }; exit 0 ;;
  check) check; exit 0 ;;
esac

# First start, or a server that was off overnight: back up now if the last one is a day old.
if [ ! -f "$DIR/last-ok" ] || [ -n "$(find "$DIR/last-ok" -mmin +1440)" ]; then backup || log "backup FAILED"; fi
while true; do
  now="$(date -u +%s)"
  next="$(date -u -d "$(date -u +%F) $AT_UTC" +%s 2>/dev/null || date -u -D '%Y-%m-%d %H:%M' -d "$(date -u +%F) $AT_UTC" +%s)"
  [ "$next" -gt "$now" ] || next=$((next + 86400))
  sleep $((next - now))
  backup || log "backup FAILED; the health check turns red after 36 hours without one"
done
