import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshDb } from './helpers/db';
import { seedLease, type Seeded } from './helpers/seed';
import { billingWindow, rentForWindow } from '../domain/renewal';

let db: PGlite;
let seeded: Seeded;

beforeAll(async () => {
  db = await freshDb();
  seeded = await seedLease(db);
}, 60_000);

afterAll(async () => db?.close());

/** The exact selection the invoice run makes, now that a part month must be caught. */
const selected = async (period: string) => {
  const { rows } = await db.query<{ start_date: string; end_date: string; effective: string | null }>(
    `select l.start_date::text, l.end_date::text, t.effective_on::text as effective
       from lease l
       join unit u on u.id = l.unit_id
       left join termination t on t.lease_id = l.id and t.status <> 'withdrawn'
      where l.status = 'active'
        and l.start_date <= ($1::date + interval '1 month' - interval '1 day')
        and least(l.end_date, coalesce(t.effective_on, l.end_date)) >= $1::date`,
    [period],
  );
  return rows;
};

describe('invoice run selection with part months', () => {
  it('catches a lease that starts mid-month', async () => {
    await db.query(`update lease set start_date = '2026-09-15' where id = $1`, [seeded.leaseId]);
    const rows = await selected('2026-09-01');
    expect(rows).toHaveLength(1);

    const window = billingWindow({
      periodStart: new Date('2026-09-01'),
      leaseStart: new Date(rows[0]!.start_date),
      leaseEnd: new Date(rows[0]!.end_date),
      terminationEffectiveOn: null,
    })!;
    expect(window.days).toBe(16);
    expect(rentForWindow({
      baseRentCents: 850000, escalationPct: 8,
      leaseStart: new Date(rows[0]!.start_date), window,
    })).toBe(453333);
  });

  it('still ignores a month entirely before the lease', async () => {
    expect(await selected('2026-08-01')).toHaveLength(0);
  });

  it('bills only the occupied days of a final part month', async () => {
    await db.query(`update lease set start_date = '2026-09-01', end_date = '2027-09-15' where id = $1`, [
      seeded.leaseId,
    ]);
    const rows = await selected('2027-09-01');
    expect(rows).toHaveLength(1);

    const window = billingWindow({
      periodStart: new Date('2027-09-01'),
      leaseStart: new Date(rows[0]!.start_date),
      leaseEnd: new Date(rows[0]!.end_date),
      terminationEffectiveOn: null,
    })!;
    // Year two rent of R9 180, fifteen of thirty days.
    expect(rentForWindow({
      baseRentCents: 850000, escalationPct: 8,
      leaseStart: new Date(rows[0]!.start_date), window,
    })).toBe(459000);
  });

  it('records which days a part month covers so the figure can be checked', async () => {
    await db.query(
      `insert into invoice (lease_id, period_start, due_on, total_cents, covers_from, covers_to)
       values ($1, '2027-09-01', '2027-09-01', 459000, '2027-09-01', '2027-09-15')`,
      [seeded.leaseId],
    );
    const { rows } = await db.query<{ covers_from: string; covers_to: string }>(
      `select covers_from::text, covers_to::text from invoice where lease_id = $1 and period_start = '2027-09-01'`,
      [seeded.leaseId],
    );
    expect(rows[0]).toEqual({ covers_from: '2027-09-01', covers_to: '2027-09-15' });
  });

  it('stops at a termination that lands before the lease end', async () => {
    await db.query(
      `insert into termination (lease_id, initiated_by, reason, notice_given_on, effective_on, notice_days)
       values ($1, 'tenant', 'early_tenant', '2026-09-05', '2026-10-20', 20)`,
      [seeded.leaseId],
    );
    const rows = await selected('2026-10-01');
    const window = billingWindow({
      periodStart: new Date('2026-10-01'),
      leaseStart: new Date(rows[0]!.start_date),
      leaseEnd: new Date(rows[0]!.end_date),
      terminationEffectiveOn: new Date(rows[0]!.effective!),
    })!;
    expect(window.days).toBe(20);
    expect(await selected('2026-11-01')).toHaveLength(0);
  });
});
