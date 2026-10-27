import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const LEASE = '66666666-6666-6666-6666-666666666666';

/** The scheduled invoice run itself, against a real Postgres (PGlite), rather than a copy of
    its query that drifted from the handler and kept passing. */
let db: typeof import('../lib/db');
let run: typeof import('../handlers/invoices-run').handler;

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://invoice-run-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'tms-storage-'));
  process.env.KMS_DRIVER = 'local';

  db = await import('../lib/db');
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  for (const file of all.filter((n) => !n.includes('seed'))) await db.execScript(read(file));
  for (const file of all.filter((n) => n.includes('seed'))) await db.execScript(read(file));
  // Fixed dates, so the months below mean the same thing whenever this runs.
  await db.query(`update lease set start_date = '2026-09-01', end_date = '2027-08-31' where id = $1`, [LEASE]);
  ({ handler: run } = await import('../handlers/invoices-run'));
}, 120_000);

const billed = async (period: string) =>
  db.query<{ total_cents: string }>(
    'select total_cents::text from invoice where lease_id = $1 and period_start = $2',
    [LEASE, period],
  );

describe('monthly invoice run', () => {
  it('bills an active lease', async () => {
    expect(await run({ periods: ['2026-10-01'] })).toEqual({ issued: 1 });
    expect(await billed('2026-10-01')).toEqual([{ total_cents: '850000' }]);
  });

  it('bills a month once however often it runs', async () => {
    expect(await run({ periods: ['2026-10-01'] })).toEqual({ issued: 0 });
    expect(await billed('2026-10-01')).toHaveLength(1);
  });

  it('does not bill before the lease starts', async () => {
    await run({ periods: ['2026-08-01'] });
    expect(await billed('2026-08-01')).toHaveLength(0);
  });

  it('keeps billing a tenant holding over past the end date with no notice and no renewal', async () => {
    // RHA s5(5): the lease continues month to month on the same terms.
    await run({ periods: ['2027-09-01'] });
    expect(await billed('2027-09-01')).toHaveLength(1);
  });

  it('stops billing once a termination has taken effect', async () => {
    // A lease stays active until the deposit is settled, which is weeks after the tenant
    // leaves. Without this the run bills empty months and they land back on the deposit.
    await db.query(
      `insert into termination (lease_id, initiated_by, reason, notice_given_on, effective_on, notice_days)
       values ($1, 'tenant', 'early_tenant', '2026-10-20', '2026-11-30', 20)`,
      [LEASE],
    );
    await run({ periods: ['2026-11-01', '2026-12-01'] });
    expect(await billed('2026-11-01')).toHaveLength(1);
    expect(await billed('2026-12-01')).toHaveLength(0);
  });

  it('bills again if the notice is withdrawn', async () => {
    await db.query(`update termination set status = 'withdrawn' where lease_id = $1`, [LEASE]);
    await run({ periods: ['2026-12-01'] });
    expect(await billed('2026-12-01')).toHaveLength(1);
  });
});
