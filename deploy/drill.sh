#!/bin/sh
# A restore rehearsal on a throwaway copy of the hosted stack. Run it on a staging server, or on
# any machine with Docker, before trusting restore.sh with real data, and after changing it:
#
#   sh deploy/drill.sh
#
# It builds the app, starts the database, the app and the backups under their own project name
# and in a temporary folder (so a real install on the same machine is not touched, and no ports
# are opened), then:
#   1. checks the roles: the app runs as tms_server and cannot change the schema, the backups run
#      as tms_backup and cannot write, and neither container holds the other's secrets
#   2. signs a landlord up through the app and stores a document
#   3. takes a backup and runs the restore check
#   4. damages the data, restores the backup, and checks the data, the documents and the app
#   5. starts a restore that fails part-way, and checks everything is put back as it was
# Everything it made is removed at the end, pass or fail. Exit code 0 means every step passed.
set -eu
repo="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
export COMPOSE_PROJECT_NAME="threshold-drill-$$"
export COMPOSE_FILE="docker-compose.yml:drill.override.yml"

step() { printf '\n== %s\n' "$*"; }
fail() { echo "DRILL FAILED: $*"; exit 1; }
compose() { docker compose --env-file .env.production "$@"; }
cleanup() {
  status=$?
  cd "$work" 2>/dev/null && docker compose --env-file .env.production down -v --remove-orphans >/dev/null 2>&1
  rm -rf "$work"
  [ "$status" -eq 0 ] && echo "DRILL PASSED" || echo "DRILL FAILED (exit $status)"
}
trap cleanup EXIT

# The kit's own files, unchanged, so what is rehearsed is what runs in production.
cp "$repo/deploy/docker-compose.yml" "$repo/deploy/backup.sh" "$repo/deploy/restore.sh" "$work/"
# DRILL_APP_IMAGE uses an image built beforehand instead of building one here.
if [ -n "${DRILL_APP_IMAGE:-}" ]; then
  app_source="image: $DRILL_APP_IMAGE
    pull_policy: never"
  build_flag=""
else
  app_source="build:
      context: $repo"
  build_flag="--build"
fi
cat > "$work/drill.override.yml" <<EOF
services:
  app:
    $app_source
    environment:
      RUN_JOBS: "false"
EOF
secret() { openssl rand -hex 24; }
sed -e "s|^DB_PASSWORD=.*|DB_PASSWORD=$(secret)|" \
    -e "s|^DB_SERVER_PASSWORD=.*|DB_SERVER_PASSWORD=$(secret)|" \
    -e "s|^DB_BACKUP_PASSWORD=.*|DB_BACKUP_PASSWORD=$(secret)|" \
    -e "s|^AUTH_SECRET=.*|AUTH_SECRET=$(openssl rand -base64 48 | tr -d '\n')|" \
    -e "s|^STORAGE_SECRET=.*|STORAGE_SECRET=$(openssl rand -base64 48 | tr -d '\n')|" \
    -e "s|^NOTIFY_MODE=.*|NOTIFY_MODE=log|" \
    -e "s|^BILLING_DRIVER=.*|BILLING_DRIVER=local|" \
    -e "s|^DOMAIN=.*|DOMAIN=drill.invalid|" \
    "$repo/deploy/.env.production.example" > "$work/.env.production"
printf 'BACKUP_KEEP_DAYS=14\n' > "$work/backup.env"
mkdir "$work/backups"
cd "$work"

# Runs SQL in a one-off database container as the given role, password from .env.production.
sql() {
  role="$1"; var="$2"; shift 2
  password="$(sed -n "s/^$var=//p" .env.production)"
  compose run --rm --no-deps -T -e PGPASSWORD="$password" --entrypoint psql db \
    -h /var/run/postgresql -U "$role" -d tms -v ON_ERROR_STOP=1 -Atc "$*"
}
owner() { sql tms_app DB_PASSWORD "$@"; }
# Runs JavaScript inside the app container, against the app on its own port.
appjs() { compose exec -T app node -e "$1"; }

step "Build and start the database, the app and the backups"
# shellcheck disable=SC2086 # empty when the image was built beforehand
compose up -d $build_flag --quiet-pull db app backup
for _ in $(seq 1 90); do
  appjs "fetch('http://127.0.0.1:3001/health').then(()=>process.exit(0),()=>process.exit(1))" 2>/dev/null && break
  sleep 2
done
appjs "fetch('http://127.0.0.1:3001/health').then(()=>process.exit(0),()=>process.exit(1))" || fail "the app never answered"
for _ in $(seq 1 60); do [ -f backups/last-ok ] && break; sleep 2; done
[ -f backups/last-ok ] || { compose logs backup | tail -20; fail "the first backup did not run"; }

step "Check the roles"
[ "$(compose exec -T app sh -c 'tr "\0" "\n" < /proc/1/environ | sed -n "s/^DB_USER=//p"')" = tms_server ] \
  || fail "the app is not running as tms_server"
compose exec -T app sh -c 'tr "\0" "\n" < /proc/1/environ | grep -q "^DB_SERVER_PASSWORD=\|^DB_BACKUP_PASSWORD="' \
  && fail "the app process still holds the role passwords"
owner_password="$(sed -n 's/^DB_PASSWORD=//p' .env.production)"
compose exec -T app sh -c 'tr "\0" "\n" < /proc/1/environ' | grep -qx "DB_PASSWORD=$owner_password" \
  && fail "the app process holds the owner's password"
compose exec -T backup sh -c 'env | grep -q "^AUTH_SECRET=\|^STORAGE_SECRET=\|^DB_PASSWORD="' \
  && fail "the backup container holds the app's secrets"
sql tms_server DB_SERVER_PASSWORD "select count(*) from landlord" >/dev/null || fail "tms_server cannot read"
sql tms_server DB_SERVER_PASSWORD "create table drill (id int)" 2>/dev/null && fail "tms_server can create tables"
sql tms_server DB_SERVER_PASSWORD "drop table audit_log" 2>/dev/null && fail "tms_server can drop tables"
sql tms_server DB_SERVER_PASSWORD "delete from schema_migrations" 2>/dev/null && fail "tms_server can edit the migration log"
sql tms_backup DB_BACKUP_PASSWORD "select count(*) from local_credential" >/dev/null || fail "tms_backup cannot read"
sql tms_backup DB_BACKUP_PASSWORD "update landlord set phone = '0'" 2>/dev/null && fail "tms_backup can write"
echo "ok"

step "Sign a landlord up through the app, and store a document"
privacy="$(sed -n "s/.*PRIVACY_VERSION = '\([^']*\)'.*/\1/p" "$repo/tms/api/src/domain/privacy.ts")"
terms="$(grep -rho "TERMS_VERSION = '[^']*'" "$repo/tms/api/src/domain" | head -n 1 | sed "s/.*'\(.*\)'/\1/")"
register() {
  appjs "fetch('http://127.0.0.1:3001/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Drill Owner', email: '$1', password: 'a-long-drill-password', consentVersion: '$privacy',
      termsVersion: '$terms', landlord: { tradingName: '$2', phone: '0825550100' } }) })
    .then(async (r) => { if (r.status !== 201) { console.error(r.status, await r.text()); process.exit(1); } })"
}
register drill@example.co.za "Drill Lets" || fail "sign-up through the app failed"
compose exec -T app sh -c 'mkdir -p /data/storage/drill && echo before > /data/storage/drill/lease.pdf'
echo "ok"

step "Back up, and run the restore check"
compose exec -T backup sh /backup.sh now
compose exec -T backup sh /backup.sh check
dump="$(find backups -maxdepth 1 -name "db-*.dump" | sort | tail -n 1 | xargs basename)"
files="$(find backups -maxdepth 1 -name "storage-*.tar.gz" | sort | tail -n 1 | xargs basename)"

step "Damage the data, then restore"
owner "update landlord set trading_name = 'DAMAGED'"
compose exec -T app sh -c 'rm /data/storage/drill/lease.pdf && echo junk > /data/storage/drill/after.txt'
printf 'RESTORE\n' | sh ./restore.sh "backups/$dump" "backups/$files"
[ "$(owner "select count(*) from landlord where trading_name = 'Drill Lets'")" = 1 ] || fail "the landlord did not come back"
[ "$(owner "select count(*) from landlord where trading_name = 'DAMAGED'")" = 0 ] || fail "the damage is still there"
[ "$(compose exec -T app cat /data/storage/drill/lease.pdf)" = before ] || fail "the document did not come back"
compose exec -T app test -e /data/storage/drill/after.txt && fail "a file from after the backup survived"
for _ in $(seq 1 60); do
  appjs "fetch('http://127.0.0.1:3001/health').then(()=>process.exit(0),()=>process.exit(1))" 2>/dev/null && break
  sleep 2
done
register second@example.co.za "After Restore" || fail "the app cannot write after the restore"
echo "ok"

step "A restore that fails part-way puts everything back"
owner "update landlord set trading_name = 'Kept' where trading_name = 'Drill Lets'"
owner "drop database if exists tms_previous" 2>/dev/null || true
compose run --rm --no-deps -T --entrypoint sh backup -c 'rm -rf /tmp/x && mkdir -p /tmp/x/not-storage && tar -czf /backups/bad.tar.gz -C /tmp/x not-storage'
# The clean-up restore.sh prints once a restore is confirmed good.
compose run --rm --no-deps -T --user root --entrypoint rm app -rf /data/storage/.restore-prev </dev/null
printf 'RESTORE\n' | sh ./restore.sh "backups/$dump" backups/bad.tar.gz && fail "the bad restore reported success"
[ "$(owner "select count(*) from landlord where trading_name = 'Kept'")" = 1 ] || fail "the database was not put back"
[ "$(compose exec -T app cat /data/storage/drill/lease.pdf)" = before ] || fail "the documents were not put back"
for _ in $(seq 1 60); do
  appjs "fetch('http://127.0.0.1:3001/health').then(()=>process.exit(0),()=>process.exit(1))" 2>/dev/null && break
  sleep 2
done
register third@example.co.za "After Rollback" || fail "the app is not working after the rollback"
echo "ok"
