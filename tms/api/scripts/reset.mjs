#!/usr/bin/env node
import { rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Wipes the local database and stored documents, then reseeds - on any OS. */
const here = dirname(fileURLToPath(import.meta.url));
const api = join(here, '..');
for (const dir of ['.pglite', '.storage']) {
  rmSync(join(api, dir), { recursive: true, force: true });
}
execFileSync(process.execPath, ['--env-file=.env', join('scripts', 'migrate.mjs'), '--seed'], {
  cwd: api,
  stdio: 'inherit',
});
