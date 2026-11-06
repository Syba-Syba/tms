#!/usr/bin/env node
/**
 * Sets up the database roles of a self-hosted server. Runs on every app start, after the
 * migrations and as the same owner role, so it is safe to run again and again.
 *
 *   tms_app     owns the database and its tables, runs migrations and restores (DB_PASSWORD)
 *   tms_server  the running app: reads and writes rows, nothing else (DB_SERVER_PASSWORD)
 *   tms_backup  reads everything, and may create the scratch database the restore check
 *               uses (DB_BACKUP_PASSWORD)
 *
 * With the app on tms_server, a bug that lets someone run SQL through the app cannot drop a
 * table, change the schema, read files off the database server or touch another database.
 */
import { grantStatements } from './db-grants.mjs';

const SERVER = 'tms_server';
const BACKUP = 'tms_backup';

const serverPassword = process.env.DB_SERVER_PASSWORD;
const backupPassword = process.env.DB_BACKUP_PASSWORD;
if (!serverPassword || !backupPassword) {
  console.error('Set DB_SERVER_PASSWORD and DB_BACKUP_PASSWORD in .env.production (see deploy/README.md).');
  process.exit(1);
}
if (serverPassword === process.env.DB_PASSWORD || backupPassword === process.env.DB_PASSWORD) {
  console.error('DB_SERVER_PASSWORD and DB_BACKUP_PASSWORD must differ from DB_PASSWORD.');
  process.exit(1);
}

const { default: pg } = await import('pg');
const client = new pg.Client({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME ?? 'tms',
  user: process.env.DB_USER ?? 'tms_app',
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'off' ? undefined : { rejectUnauthorized: true },
});
await client.connect();

const literal = (value) => client.escapeLiteral(value);
const [{ owner, database }] = (await client.query('select current_user as owner, current_database() as database')).rows;
const ident = (name) => client.escapeIdentifier(name);

await client.query('begin');
try {
  // Two servers starting at once would both try to create the roles.
  await client.query('select pg_advisory_xact_lock(hashtext($1))', ['tms-db-roles']);
  for (const role of [SERVER, BACKUP]) {
    const { rowCount } = await client.query('select 1 from pg_roles where rolname = $1', [role]);
    if (!rowCount) await client.query(`create role ${ident(role)} login`);
  }
  await client.query(
    `alter role ${ident(SERVER)} with login nosuperuser nocreatedb nocreaterole noreplication nobypassrls
       connection limit 40 password ${literal(serverPassword)}`,
  );
  await client.query(
    `alter role ${ident(BACKUP)} with login nosuperuser createdb nocreaterole noreplication nobypassrls
       connection limit 5 password ${literal(backupPassword)}`,
  );
  await client.query(`grant pg_read_all_data to ${ident(BACKUP)}`);

  for (const sql of grantStatements({ server: SERVER, backup: BACKUP, owner, database })) await client.query(sql);
  await client.query('commit');
} catch (error) {
  await client.query('rollback');
  throw error;
}

// A server set up before the socket asked for passwords still trusts it. Say so on every start
// until it is switched over, since only the database container can change it.
const trusting = await client
  .query(`select count(*)::int as n from pg_hba_file_rules where auth_method = 'trust'`)
  .then((result) => result.rows[0].n)
  .catch(() => 0);
if (trusting > 0) {
  console.warn(
    'WARNING: Postgres still trusts connections without a password on this server. ' +
      'See "Database passwords" in deploy/README.md to switch it to scram-sha-256.',
  );
}

await client.end();
console.log(`Roles ready: the app runs as ${SERVER}, backups as ${BACKUP}.`);
