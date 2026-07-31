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

/** The exact selection the scheduled invoice run makes. */
const dueLeases = async (period: string) => {
  const { rows } = await db.query<{ id: string }>(
    `select l.id
       from lease l
       join unit u on u.id = l.unit_id
       left join termination t on t.lease_id = l.id and t.status <> 'withdrawn'
      where l.status = 'active'
        and l.start_date <= $1
        and least(l.end_date, coalesce(t.effective_on, l.end_date)) >= $1`,
    [period],
  );
  return rows.length;
};

describe('monthly invoice run', () => {
  it('bills an active lease', async () => {
    expect(await dueLeases('2026-10-01')).toBe(1);
  });

  it('does not bill before the lease starts or after it ends', async () => {
    expect(await dueLeases('2026-08-01')).toBe(0);
    expect(await dueLeases('2027-09-01')).toBe(0);
  });

  it('stops billing once a termination has taken effect', async () => {
    // A lease stays active until the deposit is settled, which is weeks after the tenant
    // leaves. Without this the run bills empty months and they land back on the deposit.
    await db.query(
      `insert into termination (lease_id, initiated_by, reason, notice_given_on, effective_on, notice_days)
       values ($1, 'tenant', 'early_tenant', '2026-08-20', '2026-09-30', 20)`,
      [seeded.leaseId],
    );
    expect(await dueLeases('2026-09-01')).toBe(1);
    expect(await dueLeases('2026-10-01')).toBe(0);
  });

  it('bills again if the notice is withdrawn', async () => {
    await db.query(`update termination set status = 'withdrawn' where lease_id = $1`, [seeded.leaseId]);
    expect(await dueLeases('2026-10-01')).toBe(1);
  });
});
