#!/usr/bin/env node
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Copies each .env.example to .env, never overwriting one you have already edited. */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const pkg of ['tms/api', 'tms/app']) {
  const example = join(root, pkg, '.env.example');
  const target = join(root, pkg, '.env');
  if (!existsSync(example)) continue;
  if (existsSync(target)) {
    // An old .env survives re-downloads; make sure the keys the app depends on exist.
    const required = pkg === 'tms/app'
      ? { VITE_API_URL: 'http://localhost:3001' }
      : { NODE_ENV: 'development' };
    let current = readFileSync(target, 'utf8');
    let repaired = false;
    for (const [key, fallback] of Object.entries(required)) {
      const match = current.match(new RegExp(`^${key}=(.*)$`, 'm'));
      if (!match || !match[1].trim()) {
        current = current.replace(new RegExp(`^${key}=.*$\n?`, 'm'), '');
        current = `${key}=${fallback}\n` + current;
        repaired = true;
      }
    }
    if (repaired) {
      writeFileSync(target, current);
      console.log(`${pkg}/.env was missing required values, repaired`);
    } else {
      console.log(`${pkg}/.env already there, left alone`);
    }
    continue;
  }
  copyFileSync(example, target);
  console.log(`${pkg}/.env created`);
}
