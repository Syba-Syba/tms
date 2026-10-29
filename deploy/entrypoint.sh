#!/bin/sh
# Migrations first, every start: each is applied once, checked by checksum, and the server does
# not start on a database it cannot bring up to date.
set -e
node --import tsx scripts/migrate.mjs
# Then the roles, as the owner. The server itself connects as tms_server, which can read and
# write rows but not change the schema, and never sees the owner's password.
node scripts/db-roles.mjs
DB_USER=tms_server
DB_PASSWORD="$DB_SERVER_PASSWORD"
export DB_USER DB_PASSWORD
unset DB_SERVER_PASSWORD DB_BACKUP_PASSWORD
exec node --import tsx src/server.ts
