import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshDb } from './helpers/db';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
// The dev seed occupies a number in the sequence but is never applied to a real database.
const files = all.filter((n) => !n.includes('seed'));

let db: PGlite;
beforeAll(async () => {
  db = await freshDb();
}, 60_000);
afterAll(async () => db?.close());

describe('migrations', () => {
  it('are numbered without gaps or duplicates', () => {
    const numbers = all.map((name) => Number(name.slice(0, 4)));
    expect(numbers).toEqual(numbers.map((_, index) => index + 1));
  });

  it('keeps the dev seeds out of what gets applied', () => {
    // Four seeds: the world (0002), the sign-ins for its people (0014), the landlord's account
    // details (0026) and the applicant's screening consent (0034).
    expect(all.length - files.length).toBe(4);
    expect(files.some((name) => name.includes('seed'))).toBe(false);
  });

  it('apply in order on a stock Postgres with no extensions', async () => {
    const { rows } = await db.query<{ count: string }>(
      `select count(*)::text as count from information_schema.tables where table_schema = 'public'`,
    );
    expect(Number(rows[0]!.count)).toBeGreaterThanOrEqual(23);
  });

  it('index every foreign key that a request path joins through', async () => {
    const { rows } = await db.query<{ tablename: string; indexdef: string }>(
      `select tablename, indexdef from pg_indexes where schemaname = 'public'`,
    );
    const indexed = (table: string, column: string) =>
      rows.some((row) => row.tablename === table && row.indexdef.includes(`(${column}`));

    // Postgres does not index a foreign key automatically, and this chain is walked on
    // every authenticated call.
    expect(indexed('unit', 'property_id')).toBe(true);
    expect(indexed('property', 'landlord_id')).toBe(true);
    expect(indexed('lease', 'applicant_id')).toBe(true);
    expect(indexed('invoice_line', 'invoice_id')).toBe(true);
  });

  it('are immutable once applied, which the runner checks by checksum', () => {
    const checksums = new Map(
      files.map((name) => [name, createHash('sha256').update(readFileSync(join(MIGRATIONS, name), 'utf8')).digest('hex')]),
    );
    expect(checksums.size).toBe(files.length);
    for (const value of checksums.values()) expect(value).toHaveLength(64);
  });
});
