#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Fills the development database with a believable few months of a landlord's business, for
 * demos and screenshots. Development and PGlite only: it writes fixed ids and invented people.
 * Stop `npm run dev` first; PGlite is one process against one folder.
 */
if (process.env.NODE_ENV !== 'development' || process.env.DB_DRIVER !== 'pglite') {
  console.error('npm run demo is for the development PGlite database only.');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const { PGlite } = await import('@electric-sql/pglite');
const db = await PGlite.create(process.env.PGLITE_DIR ?? './.pglite');
try {
  const { rows } = await db.query(`select 1 from property where name = 'Melville Gardens'`);
  if (rows.length > 0) {
    console.log('Demo data is already there. Run `npm run reset` first for a clean copy.');
  } else {
    await db.exec(readFileSync(join(here, 'demo.sql'), 'utf8'));
    console.log('Demo data added: Melville Gardens, two more tenants, rent history, expenses and a repair.');
  }
} finally {
  await db.close();
}
