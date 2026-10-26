#!/usr/bin/env node
/**
 * Opens psql, or runs pg_dump, against whatever database the env file points at, so the
 * credentials live in one place instead of in someone's shell history.
 *
 *   npm run db:psql
 *   npm run db:dump > backup.sql
 *
 * PGlite has no server and no socket, so there is nothing for psql to connect to: it is one
 * process against one folder, and the API server holds it. Switch DB_DRIVER to postgres, or
 * stop the server first and read the folder from a script.
 */
import { spawn } from 'node:child_process';

if (process.env.DB_DRIVER === 'pglite') {
  console.error(
    'DB_DRIVER=pglite has no server to connect to. psql cannot reach it while the API is\n' +
      'running, because PGlite is a single process holding the directory.\n' +
      'Use Postgres for this: see "Running it for real without AWS" in the README.',
  );
  process.exit(1);
}

// Only swallow argv[2] when it is the mode word, or `npm run db:psql -- -c "..."` loses its
// first flag and psql opens an interactive session instead of running the query.
const dump = process.argv[2] === 'dump';
const tool = dump ? 'pg_dump' : 'psql';
const passthrough = process.argv.slice(dump ? 3 : 2);
const args = [
  '-h', process.env.DB_HOST ?? '127.0.0.1',
  '-p', process.env.DB_PORT ?? '5432',
  '-U', process.env.DB_USER ?? 'tms_app',
  '-d', process.env.DB_NAME ?? 'tms',
  ...passthrough,
];

const child = spawn(tool, args, {
  stdio: 'inherit',
  env: { ...process.env, PGPASSWORD: process.env.DB_PASSWORD ?? '' },
});
child.on('error', (error) => {
  console.error(`Could not run ${tool}: ${error.message}`);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 0));
