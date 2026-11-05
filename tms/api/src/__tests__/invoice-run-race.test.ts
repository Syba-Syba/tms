import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * The invoice run against real Postgres. PGlite runs one transaction at a time, so a race
 * between two transactions cannot happen there and a test of one proves nothing. CI starts a
 * Postgres service and sets TEST_PG_HOST; without it this file is skipped.
 *
 * The race: adding a charge locks the lease, sees no invoice for the month yet, and leaves the
 * charge pending for the run to pick up. If the run did not take the same lock, it could insert
 * the invoice and sweep the (still empty) pending charges in between, and the charge would sit
 * pending for a month that is already billed, never charged.
 */
const host = process.env.TEST_PG_HOST;
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const PROPERTY = '22222222-2222-2222-2222-222222222222';
const APPLICANT = '44444444-4444-4444-4444-444444444444';

let db: typeof import('../lib/db');
let bill: typeof import('../handlers/invoices-run').handler;
let admin: pg.Client;

describe.skipIf(!host)('the invoice run against Postgres', () => {
  beforeAll(async () => {
    const connection = {
      host,
      port: Number(process.env.TEST_PG_PORT ?? 5432),
      user: process.env.TEST_PG_USER ?? 'postgres',
      password: process.env.TEST_PG_PASSWORD ?? 'postgres',
      database: process.env.TEST_PG_DATABASE ?? 'postgres',
    };
    admin = new pg.Client(connection);
    await admin.connect();
    await admin.query('drop schema if exists public cascade; create schema public;');
    const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
    const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
    for (const file of all.filter((n) => !n.includes('seed'))) await admin.query(read(file));
    for (const file of all.filter((n) => n.includes('seed'))) await admin.query(read(file));

    process.env.NODE_ENV = 'development';
    process.env.DB_DRIVER = 'postgres';
    process.env.DB_SSL = 'off';
    process.env.DB_HOST = connection.host!;
    process.env.DB_PORT = String(connection.port);
    process.env.DB_NAME = connection.database;
    process.env.DB_USER = connection.user;
    process.env.DB_PASSWORD = connection.password;
    process.env.DB_POOL_MAX = '5';
    process.env.DB_SECRET_ARN = 'unused';
    process.env.DOCS_BUCKET = 'unused';
    process.env.KMS_KEY_ID = 'unused';
    process.env.NOTIFY_MODE = 'skip';
    db = await import('../lib/db');
    ({ handler: bill } = await import('../handlers/invoices-run'));
  }, 120_000);

  afterAll(async () => {
    await admin?.end();
    await db?.getPool().end();
  });

  it('waits for a charge being added to the lease, then bills it on the invoice', async () => {
    const [unit] = await db.query<{ id: string }>(
      `insert into unit (property_id, code, bedrooms, bathrooms, monthly_rent_cents, deposit_cents, status)
       values ($1, 'RACE1', 1, 1, 900000, 900000, 'occupied') returning id`,
      [PROPERTY],
    );
    const [application] = await db.query<{ id: string }>(
      `insert into application (unit_id, applicant_id, status, preferred_move_in)
       values ($1, $2, 'approved', current_date) returning id`,
      [unit!.id, APPLICANT],
    );
    const [lease] = await db.query<{ id: string }>(
      `insert into lease (application_id, unit_id, applicant_id, start_date, end_date,
                          monthly_rent_cents, escalation_pct, deposit_cents, status)
       values ($1, $2, $3, '2026-01-01', '2026-12-31', 900000, 0, 900000, 'active') returning id`,
      [application!.id, unit!.id, APPLICANT],
    );

    // The charge's transaction: it holds the lease, found no invoice for August, and is about
    // to leave the charge pending.
    const charge = new pg.Client({
      host, port: Number(process.env.TEST_PG_PORT ?? 5432), user: process.env.DB_USER,
      password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    });
    await charge.connect();
    await charge.query('begin');
    await charge.query('select id from lease where id = $1 for update', [lease!.id]);

    let finished = false;
    const run = bill({ periods: ['2026-08-01'] }).finally(() => {
      finished = true;
    });
    // The run must be waiting on the lease, not done. Without its lock it finishes here.
    const deadline = Date.now() + 5_000;
    let waiting = false;
    while (!finished && Date.now() < deadline) {
      const [row] = (
        await admin.query(
          `select count(*)::int as n from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'`,
        )
      ).rows as { n: number }[];
      if (row!.n > 0) {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    await charge.query(
      `insert into pending_charge (lease_id, period_start, kind, description, amount_cents, added_by)
       values ($1, '2026-08-01', 'utility', 'Water', 25000, 'sub-landlord')`,
      [lease!.id],
    );
    await charge.query('commit');
    await charge.end();
    await run;

    expect(waiting).toBe(true);
    const invoices = await db.query<{ id: string; total_cents: string }>(
      'select id, total_cents::text from invoice where lease_id = $1',
      [lease!.id],
    );
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.total_cents).toBe(String(900000 + 25000));
    expect(await db.query('select 1 from pending_charge where lease_id = $1', [lease!.id])).toHaveLength(0);
  });

  it('bills each month once when runs overlap', async () => {
    await Promise.all([1, 2, 3, 4].map(() => bill({ periods: ['2026-09-01'] })));
    const duplicates = await db.query(
      `select lease_id from invoice where period_start = '2026-09-01' group by lease_id having count(*) > 1`,
    );
    expect(duplicates).toHaveLength(0);
    const lines = await db.query(
      `select i.id from invoice i join invoice_line l on l.invoice_id = i.id and l.kind = 'rent'
        where i.period_start = '2026-09-01' group by i.id having count(*) > 1`,
    );
    expect(lines).toHaveLength(0);
  });
});
