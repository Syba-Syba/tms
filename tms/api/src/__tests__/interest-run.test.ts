import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { monthlyInterestCents } from '../domain/money';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const LEASE = '66666666-6666-6666-6666-666666666666';

/** The scheduled interest run itself, not a copy of its insert. The seed holds a R8 500
    deposit on the one lease, and the seeded rate is 5.5% p.a. */
let db: typeof import('../lib/db');
let run: typeof import('../handlers/interest-run').handler;

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://interest-run-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'tms-storage-'));
  process.env.KMS_DRIVER = 'local';

  db = await import('../lib/db');
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  for (const file of all.filter((n) => !n.includes('seed'))) await db.execScript(read(file));
  for (const file of all.filter((n) => n.includes('seed'))) await db.execScript(read(file));
  ({ handler: run } = await import('../handlers/interest-run'));
}, 120_000);

afterAll(() => {
  vi.useRealTimers();
});

/** The handler dates its month from the clock: 06:00 SAST on the given day. */
const on = (iso: string) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${iso}T04:00:00Z`));
};

const balance = async () => {
  const [row] = await db.query<{ balance: string }>(
    `select coalesce(sum(case entry_type
              when 'received' then amount_cents
              when 'interest' then amount_cents
              else -amount_cents end), 0)::text as balance
       from deposit_ledger where lease_id = $1`,
    [LEASE],
  );
  return Number(row!.balance);
};

const interest = () =>
  db.query<{ period_month: string; amount_cents: string; note: string }>(
    `select period_month::text, amount_cents::text, note from deposit_ledger
      where lease_id = $1 and entry_type = 'interest' order by period_month`,
    [LEASE],
  );

describe('monthly deposit interest run', () => {
  it('posts one month of interest on the held deposit', async () => {
    on('2026-10-01');
    expect(await run()).toEqual({ posted: 1, skipped: 0 });
    expect(await interest()).toEqual([
      { period_month: '2026-10-01', amount_cents: '3896', note: 'Interest at 5.5% p.a.' },
    ]);
    expect(await balance()).toBe(850000 + 3896);
  });

  /**
   * EventBridge delivers a schedule at least once, and the self-hosted scheduler retries, so
   * the same run can arrive twice. It used to credit the deposit again each time.
   */
  it('credits nothing the second time the same month is run', async () => {
    const before = await balance();
    on('2026-10-01');
    expect(await run()).toEqual({ posted: 0, skipped: 1 });
    expect(await interest()).toHaveLength(1);
    expect(await balance()).toBe(before);
  });

  it('posts the following month on the new balance', async () => {
    const before = await balance();
    on('2026-11-01');
    expect(await run()).toEqual({ posted: 1, skipped: 0 });
    expect(await balance()).toBe(before + monthlyInterestCents(before, 5.5));
  });

  it('pays the rate the landlord set, from the month it takes effect', async () => {
    await db.query(`insert into deposit_interest_rate (annual_pct, effective_from) values (6.250, '2026-12-01')`);
    const before = await balance();
    on('2026-12-01');
    await run();
    const rows = await interest();
    expect(rows.at(-1)).toMatchObject({ period_month: '2026-12-01', note: 'Interest at 6.25% p.a.' });
    expect(await balance()).toBe(before + monthlyInterestCents(before, 6.25));
  });

  it('pays nothing on a lease that has ended', async () => {
    await db.query(`update lease set status = 'terminated' where id = $1`, [LEASE]);
    on('2027-01-01');
    expect(await run()).toEqual({ posted: 0, skipped: 0 });
    await db.query(`update lease set status = 'active' where id = $1`, [LEASE]);
  });

  it('refuses an interest entry with no month, which would slip past the unique index', async () => {
    await expect(
      db.query(
        `insert into deposit_ledger (lease_id, entry_type, amount_cents, note)
         values ($1, 'interest', 1000, 'No month')`,
        [LEASE],
      ),
    ).rejects.toThrow(/deposit_ledger_interest_has_month/);
  });
});
