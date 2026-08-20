import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshDb, all, one } from './helpers/db';
import { seedLease, type Seeded } from './helpers/seed';
import { monthlyInterestCents } from '../domain/money';

let db: PGlite;
let seeded: Seeded;

beforeAll(async () => {
  db = await freshDb();
  seeded = await seedLease(db);
  await db.query(
    `insert into deposit_ledger (lease_id, entry_type, amount_cents, occurred_on, note)
     values ($1, 'received', 850000, '2026-09-01', 'Deposit received')`,
    [seeded.leaseId],
  );
}, 60_000);

afterAll(async () => db?.close());

const ANNUAL_PCT = 5.5;

/**
 * The insert the scheduled run makes. Kept in the test rather than importing the handler so
 * the database guard is what is under test, not the handler's own bookkeeping.
 */
const postInterest = async (periodMonth: string, amountCents: number) =>
  all<{ id: string }>(
    db,
    `insert into deposit_ledger (lease_id, entry_type, amount_cents, period_month, note)
     values ($1, 'interest', $2, $3, 'Interest at 5.5% p.a.')
     on conflict (lease_id, period_month) where entry_type = 'interest' do nothing
     returning id`,
    [seeded.leaseId, amountCents, periodMonth],
  );

const balance = async () =>
  Number(
    (
      await one<{ balance: string }>(
        db,
        `select coalesce(sum(case entry_type
                  when 'received' then amount_cents
                  when 'interest' then amount_cents
                  else -amount_cents end), 0)::text as balance
           from deposit_ledger where lease_id = $1`,
        [seeded.leaseId],
      )
    )?.balance ?? 0,
  );

const interestRows = async () =>
  Number(
    (
      await one<{ n: string }>(
        db,
        `select count(*)::text as n from deposit_ledger
          where lease_id = $1 and entry_type = 'interest'`,
        [seeded.leaseId],
      )
    )?.n ?? 0,
  );

describe('monthly deposit interest run', () => {
  it('posts one month of interest on the held deposit', async () => {
    const expected = monthlyInterestCents(850000, ANNUAL_PCT);
    expect(expected).toBe(3896);

    const inserted = await postInterest('2026-10-01', expected);
    expect(inserted).toHaveLength(1);
    expect(await interestRows()).toBe(1);
    expect(await balance()).toBe(850000 + expected);
  });

  /**
   * EventBridge delivers a schedule at least once, so the same run can arrive twice. It used
   * to credit the deposit again each time, silently inflating money the tenant is owed and
   * the exit settlement is computed from.
   */
  it('credits nothing the second time the same month is run', async () => {
    const before = await balance();
    const expected = monthlyInterestCents(850000, ANNUAL_PCT);

    const again = await postInterest('2026-10-01', expected);

    expect(again).toHaveLength(0);
    expect(await interestRows()).toBe(1);
    expect(await balance()).toBe(before);
  });

  it('still posts the following month', async () => {
    const before = await balance();
    const expected = monthlyInterestCents(before, ANNUAL_PCT);

    const inserted = await postInterest('2026-11-01', expected);

    expect(inserted).toHaveLength(1);
    expect(await interestRows()).toBe(2);
    expect(await balance()).toBe(before + expected);
  });

  it('refuses an interest entry with no month, which would slip past the unique index', async () => {
    await expect(
      db.query(
        `insert into deposit_ledger (lease_id, entry_type, amount_cents, note)
         values ($1, 'interest', 1000, 'No month')`,
        [seeded.leaseId],
      ),
    ).rejects.toThrow(/deposit_ledger_interest_has_month/);
  });

  it('leaves the other ledger entry types alone', async () => {
    // Only interest is once-per-month. A deposit can legitimately be received twice.
    await db.query(
      `insert into deposit_ledger (lease_id, entry_type, amount_cents, occurred_on, note)
       values ($1, 'received', 50000, '2026-10-05', 'Top up')`,
      [seeded.leaseId],
    );
    await db.query(
      `insert into deposit_ledger (lease_id, entry_type, amount_cents, occurred_on, note)
       values ($1, 'received', 50000, '2026-10-06', 'Second top up')`,
      [seeded.leaseId],
    );
    const received = await one<{ n: string }>(
      db,
      `select count(*)::text as n from deposit_ledger
        where lease_id = $1 and entry_type = 'received'`,
      [seeded.leaseId],
    );
    expect(Number(received?.n)).toBe(3);
  });
});
