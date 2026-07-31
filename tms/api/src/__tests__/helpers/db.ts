import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '../../../../db/migrations');

/** A real Postgres, migrated exactly the way production is, one per test file. */
export async function freshDb() {
  const db = await PGlite.create();
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql') && !name.includes('seed'))
    .sort();
  for (const file of files) {
    await db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
  return db;
}

export const one = async <T>(db: PGlite, sql: string, params: unknown[] = []) =>
  (await db.query<T>(sql, params)).rows[0];

export const all = async <T>(db: PGlite, sql: string, params: unknown[] = []) =>
  (await db.query<T>(sql, params)).rows;
