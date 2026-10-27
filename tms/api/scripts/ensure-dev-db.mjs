#!/usr/bin/env node
import { existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The development database used to be committed, so a fresh clone had one. It is ignored
 * now (every run rewrote ~80 binary files), so `npm run dev` builds it from the migrations
 * and seeds the first time, and leaves an existing one alone.
 */
const api = join(dirname(fileURLToPath(import.meta.url)), '..');
if (process.env.DB_DRIVER !== 'pglite') process.exit(0);

const dir = resolve(api, process.env.PGLITE_DIR ?? './.pglite');
if (existsSync(dir) && readdirSync(dir).length > 0) {
  // An existing database still needs the migrations added since it was made, or the API
  // fails on the first query that touches a new column.
  execFileSync(process.execPath, ['--env-file=.env', join('scripts', 'migrate.mjs')], {
    cwd: api,
    stdio: 'inherit',
  });
  process.exit(0);
}

console.log(`No development database at ${dir}; creating and seeding it.`);
execFileSync(process.execPath, ['--env-file=.env', join('scripts', 'migrate.mjs'), '--seed'], {
  cwd: api,
  stdio: 'inherit',
});
