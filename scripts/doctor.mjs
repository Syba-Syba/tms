#!/usr/bin/env node
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Checks the things that have actually gone wrong, and says what to run for each. */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];
const check = (label, ok, fix) => checks.push({ label, ok, fix });

const [major] = process.versions.node.split('.').map(Number);
check(`Node ${process.versions.node}`, major >= 20, 'Install Node 20 or newer.');

check('workspace root', existsSync(join(root, 'package.json')) && existsSync(join(root, 'toolbox')),
  'Run commands from the folder holding package.json, toolbox and tms.');

check('dependencies installed', existsSync(join(root, 'node_modules')), 'npm install');

check('toolbox built', existsSync(join(root, 'toolbox/dist/ui/index.js')),
  'npm run build');

for (const pkg of ['tms/api', 'tms/app']) {
  check(`${pkg}/.env`, existsSync(join(root, pkg, '.env')), 'npm run env');
}

const apiEnv = join(root, 'tms/api/.env');
if (existsSync(apiEnv)) {
  const text = (await import('node:fs')).readFileSync(apiEnv, 'utf8');
  const pglite = /^DB_DRIVER=pglite/m.test(text);
  const dir = join(root, 'tms/api', (text.match(/^PGLITE_DIR=(.*)$/m)?.[1] ?? './.pglite').trim());
  if (pglite) {
    check('database created', existsSync(dir), 'npm run setup -w tms-api');
  }
}

const migrations = join(root, 'db/migrations');
const nested = join(root, 'tms/db/migrations');
check('migrations found', existsSync(migrations) || existsSync(nested),
  'The download is incomplete, re-extract it.');

let bad = 0;
for (const item of checks) {
  console.log(`${item.ok ? ' ok ' : 'FAIL'}  ${item.label}${item.ok ? '' : `   -> ${item.fix}`}`);
  if (!item.ok) bad += 1;
}
console.log(bad === 0 ? '\nEverything checks out. npm run dev' : `\n${bad} to fix, see above.`);
process.exit(bad === 0 ? 0 : 1);
