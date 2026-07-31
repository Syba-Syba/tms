import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshDb } from './helpers/db';
import { seedLease } from './helpers/seed';

let db: PGlite;
let seeded: Awaited<ReturnType<typeof seedLease>>;

beforeAll(async () => {
  db = await freshDb();
  seeded = await seedLease(db);
}, 60_000);

afterAll(async () => db?.close());

const run = (sql: string, params: unknown[] = []) => db.query(sql, params);

describe('migrations', () => {
  it('apply in order on a stock Postgres with no extensions', async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public'`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(23);
  });

  it('gives leases and invoices short human references', async () => {
    expect(seeded.leaseRef).toBeGreaterThan(0);
    expect(`LSE-${String(seeded.leaseRef).padStart(5, '0')}`).toMatch(/^LSE-\d{5}$/);
  });
});

describe('constraints that protect the money', () => {
  it('allows only one live lease per unit', async () => {
    // Renamed in migration 0010 when 'scheduled' was added for renewals.
    const application = await db.query<{ id: string }>(
      `insert into application (unit_id, applicant_id, status, preferred_move_in)
       values ($1, $2, 'approved', '2027-09-01') returning id`,
      [seeded.unitId, seeded.applicantId],
    );
    await expect(
      run(
        `insert into lease (application_id, unit_id, applicant_id, start_date, end_date,
                            monthly_rent_cents, deposit_cents, status)
         values ($1, $2, $3, '2027-09-01', '2028-08-31', 900000, 900000, 'active')`,
        [application.rows[0]!.id, seeded.unitId, seeded.applicantId],
      ),
    ).rejects.toThrow(/lease_one_live_per_unit/);
  });

  it('refuses a negative deposit ledger entry', async () => {
    await expect(
      run(`insert into deposit_ledger (lease_id, entry_type, amount_cents) values ($1, 'received', -500000)`, [
        seeded.leaseId,
      ]),
    ).rejects.toThrow(/deposit_ledger_amount_positive/);
  });

  it('refuses an effective date that precedes its own notice', async () => {
    await expect(
      run(
        `insert into termination (lease_id, initiated_by, reason, notice_given_on, effective_on, notice_days)
         values ($1, 'tenant', 'early_tenant', '2026-07-27', '2026-06-30', 20)`,
        [seeded.leaseId],
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it('bills a period only once per lease', async () => {
    await run(
      `insert into invoice (lease_id, period_start, due_on, total_cents) values ($1, '2026-10-01', '2026-10-01', 850000)`,
      [seeded.leaseId],
    );
    const second = await db.query<{ id: string }>(
      `insert into invoice (lease_id, period_start, due_on, total_cents)
       values ($1, '2026-10-01', '2026-10-01', 850000)
       on conflict (lease_id, period_start) do nothing returning id`,
      [seeded.leaseId],
    );
    expect(second.rows).toHaveLength(0);
  });
});
