import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshDb } from './helpers/db';
import { seedLease, type Seeded } from './helpers/seed';

let db: PGlite;
let seeded: Seeded;
let newLeaseId: string;

beforeAll(async () => {
  db = await freshDb();
  seeded = await seedLease(db);
  await db.query(
    `insert into deposit_ledger (lease_id, entry_type, amount_cents) values
       ($1, 'received', 850000), ($1, 'interest', 46752)`,
    [seeded.leaseId],
  );
}, 60_000);

afterAll(async () => db?.close());

describe('the handover a renewal needs', () => {
  it('refuses to let a second lease go live on the same unit', async () => {
    const { rows } = await db.query<{ application_id: string }>(
      'select application_id from lease where id = $1',
      [seeded.leaseId],
    );
    await expect(
      db.query(
        `insert into lease (application_id, unit_id, applicant_id, start_date, end_date,
                            monthly_rent_cents, deposit_cents, status)
         values ($1, $2, $3, '2027-09-01', '2028-08-31', 918000, 918000, 'active')`,
        [rows[0]!.application_id, seeded.unitId, seeded.applicantId],
      ),
    ).rejects.toThrow(/lease_one_live_per_unit/);
  });

  it('parks the signed renewal as scheduled alongside the live lease', async () => {
    const { rows } = await db.query<{ application_id: string }>(
      'select application_id from lease where id = $1',
      [seeded.leaseId],
    );
    const created = await db.query<{ id: string }>(
      `insert into lease (application_id, unit_id, applicant_id, start_date, end_date,
                          monthly_rent_cents, escalation_pct, deposit_cents, status, previous_lease_id)
       values ($1, $2, $3, '2027-09-01', '2028-08-31', 918000, 8, 918000, 'scheduled', $4)
       returning id`,
      [rows[0]!.application_id, seeded.unitId, seeded.applicantId, seeded.leaseId],
    );
    newLeaseId = created.rows[0]!.id;
    expect(newLeaseId).toBeTruthy();
  });

  it('allows only one queued lease per unit', async () => {
    const { rows } = await db.query<{ application_id: string }>(
      'select application_id from lease where id = $1',
      [seeded.leaseId],
    );
    await expect(
      db.query(
        `insert into lease (application_id, unit_id, applicant_id, start_date, end_date,
                            monthly_rent_cents, deposit_cents, status)
         values ($1, $2, $3, '2028-09-01', '2029-08-31', 990000, 990000, 'scheduled')`,
        [rows[0]!.application_id, seeded.unitId, seeded.applicantId],
      ),
    ).rejects.toThrow(/lease_one_scheduled_per_unit/);
  });

  it('swaps live and scheduled in one transaction without breaking the index', async () => {
    // Both statements in one commit. Doing them apart would leave two live leases for an
    // instant, and the unique index refuses that.
    await db.exec('begin');
    await db.query(`update lease set status = 'terminated' where id = '${seeded.leaseId}'`);
    await db.query(`update lease set status = 'active', activated_at = now() where id = '${newLeaseId}'`);
    await db.query(`update deposit_ledger set lease_id = '${newLeaseId}' where lease_id = '${seeded.leaseId}'`);
    await db.exec('commit');

    const { rows } = await db.query<{ status: string; count: string }>(
      `select status, count(*)::text as count from lease where unit_id = $1 group by status order by status`,
      [seeded.unitId],
    );
    expect(rows).toEqual([
      { status: 'active', count: '1' },
      { status: 'terminated', count: '1' },
    ]);
  });

  it('carries the deposit and its interest across instead of refunding it', async () => {
    const { rows } = await db.query<{ balance: string }>(
      `select sum(case entry_type when 'received' then amount_cents when 'interest' then amount_cents
                                  else -amount_cents end)::text as balance
         from deposit_ledger where lease_id = $1`,
      [newLeaseId],
    );
    expect(Number(rows[0]!.balance)).toBe(896752);

    const old = await db.query<{ count: string }>(
      `select count(*)::text as count from deposit_ledger where lease_id = $1`,
      [seeded.leaseId],
    );
    expect(Number(old.rows[0]!.count)).toBe(0);
  });

  it('keeps the chain traceable back through every renewal', async () => {
    const { rows } = await db.query<{ previous_lease_id: string }>(
      'select previous_lease_id from lease where id = $1',
      [newLeaseId],
    );
    expect(rows[0]!.previous_lease_id).toBe(seeded.leaseId);
  });
});

describe('renewal offers', () => {
  it('allows only one open offer per lease but keeps the declined ones', async () => {
    const insert = (status: string) =>
      db.query(
        `insert into renewal (lease_id, respond_by, term_months, new_start_date, new_end_date,
                              new_rent_cents, status)
         values ($1, '2027-07-15', 12, '2027-09-01', '2028-08-31', 918000, $2)`,
        [newLeaseId, status],
      );
    await insert('declined');
    await insert('lapsed');
    await insert('offered');
    await expect(insert('offered')).rejects.toThrow(/renewal_one_open_per_lease/);
  });

  it('refuses an offer whose deadline falls after the new lease has already started', async () => {
    await expect(
      db.query(
        `insert into renewal (lease_id, respond_by, term_months, new_start_date, new_end_date, new_rent_cents)
         values ($1, '2027-10-01', 12, '2027-09-01', '2028-08-31', 918000)`,
        [seeded.leaseId],
      ),
    ).rejects.toThrow(/check constraint/);
  });
});
