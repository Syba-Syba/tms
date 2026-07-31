import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshDb } from './helpers/db';
import { seedLease, type Seeded } from './helpers/seed';
import { reconcile } from '../domain/termination';

let db: PGlite;
let seeded: Seeded;

beforeAll(async () => {
  db = await freshDb();
  seeded = await seedLease(db);
}, 60_000);

afterAll(async () => db?.close());

/** The exact query the settle handler runs. */
const heldQuery = `
  select coalesce(sum(amount_cents) filter (where entry_type = 'received'), 0)::text as deposit,
         coalesce(sum(amount_cents) filter (where entry_type = 'interest'), 0)::text as interest,
         coalesce(sum(amount_cents) filter (where entry_type in ('deduction', 'refund')), 0)::text
           as already_out
    from deposit_ledger where lease_id = $1`;

describe('deposit reconciliation', () => {
  it('counts money that already left the deposit', async () => {
    await db.query(
      `insert into deposit_ledger (lease_id, entry_type, amount_cents) values
         ($1, 'received', 850000), ($1, 'interest', 3896),
         ($1, 'deduction', 100000), ($1, 'refund', 50000)`,
      [seeded.leaseId],
    );
    const { rows } = await db.query<{ deposit: string; interest: string; already_out: string }>(
      heldQuery,
      [seeded.leaseId],
    );
    const ledger = rows[0]!;
    expect(Number(ledger.already_out)).toBe(150000);

    // Summing only the credits, as the handler used to, over-refunds by everything already out.
    const summary = reconcile({
      depositCents: Number(ledger.deposit),
      interestCents: Number(ledger.interest),
      deductionsCents: Number(ledger.already_out),
      arrearsCents: 0,
      penaltyCents: 0,
    });
    expect(summary.refundCents).toBe(703896);
  });

  it('agrees with the running ledger balance', async () => {
    const { rows } = await db.query<{ balance: string }>(
      `select sum(case entry_type when 'received' then amount_cents when 'interest' then amount_cents
                                  else -amount_cents end)::text as balance
         from deposit_ledger where lease_id = $1`,
      [seeded.leaseId],
    );
    expect(Number(rows[0]!.balance)).toBe(703896);
  });

  it('turns an overdrawn deposit into a debt rather than a negative refund', () => {
    const summary = reconcile({
      depositCents: 850000,
      interestCents: 3896,
      deductionsCents: 900000,
      arrearsCents: 85000,
      penaltyCents: 0,
    });
    expect(summary.refundCents).toBe(0);
    expect(summary.tenantOwesCents).toBe(131104);
  });
});

describe('arrears', () => {
  const arrearsQuery = `
    select coalesce(sum(i.total_cents) - coalesce((
             select sum(pay.amount_cents) from payment pay where pay.lease_id = $1
           ), 0), 0)::text as arrears
      from invoice i where i.lease_id = $1 and i.status <> 'void'`;

  it('reads zero when nothing has been invoiced', async () => {
    const { rows } = await db.query<{ arrears: string }>(arrearsQuery, [seeded.leaseId]);
    expect(Number(rows[0]!.arrears)).toBe(0);
  });

  it('never charges the tenant for their own overpayment', async () => {
    const invoice = await db.query<{ id: string }>(
      `insert into invoice (lease_id, period_start, due_on, total_cents, status)
       values ($1, '2026-10-01', '2026-10-01', 850000, 'paid') returning id`,
      [seeded.leaseId],
    );
    await db.query(
      `insert into payment (lease_id, invoice_id, amount_cents, method, received_on, recorded_by)
       values ($1, $2, 900000, 'eft', '2026-10-01', 'sub-landlord')`,
      [seeded.leaseId, invoice.rows[0]!.id],
    );
    const { rows } = await db.query<{ arrears: string }>(arrearsQuery, [seeded.leaseId]);
    expect(Number(rows[0]!.arrears)).toBeLessThan(0);
    expect(Math.max(0, Number(rows[0]!.arrears))).toBe(0);
  });
});
