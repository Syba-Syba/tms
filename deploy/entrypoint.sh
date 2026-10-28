#!/bin/sh
# Migrations first, every start: each is applied once, checked by checksum, and the server does
# not start on a database it cannot bring up to date.
set -e
node --import tsx scripts/migrate.mjs
exec node --import tsx src/server.ts
