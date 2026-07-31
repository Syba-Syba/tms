import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshDb } from './helpers/db';
import { seedLease, type Seeded } from './helpers/seed';

let db: PGlite;
let seeded: Seeded;

beforeAll(async () => {
  db = await freshDb();
  seeded = await seedLease(db);
}, 60_000);

afterAll(async () => db?.close());

/**
 * Spotted in a browser: an application's preferred move-in date came back as
 * 2026-08-28T22:00:00Z when the row held 2026-08-29. A date is a day, not an instant, and
 * turning it into one loses a day for anyone east of Greenwich.
 */
describe('date-only columns', () => {
  it('keeps the day when a date is cast to text', async () => {
    await db.query(`update lease set start_date = '2026-08-29' where id = $1`, [seeded.leaseId]);
    const { rows } = await db.query<{ start_date: string }>(
      'select start_date::text from lease where id = $1',
      [seeded.leaseId],
    );
    expect(rows[0]!.start_date).toBe('2026-08-29');
  });

  it('never renders a date as a shifted instant', async () => {
    const { rows } = await db.query<{ start_date: string }>(
      'select start_date::text from lease where id = $1',
      [seeded.leaseId],
    );
    expect(JSON.parse(JSON.stringify(rows[0]))).toEqual({ start_date: '2026-08-29' });
    expect(rows[0]!.start_date).not.toContain('T');
  });

  it('survives a timezone west of Postgres', async () => {
    const original = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    const { rows } = await db.query<{ due_on: string }>(
      `select '2027-09-24'::date::text as due_on`,
    );
    expect(rows[0]!.due_on).toBe('2027-09-24');
    process.env.TZ = original;
  });
});
