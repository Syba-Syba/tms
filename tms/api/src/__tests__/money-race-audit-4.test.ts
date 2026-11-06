import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * Money recorded by two requests at once, against real Postgres (PGlite runs one transaction
 * at a time, so nothing here can race there). Skipped unless TEST_PG_HOST is set; see
 * invoice-run-race.test.ts.
 *
 * 1. Two allocations on one invoice: the second waited for the invoice lock but summed the
 *    payments from before the wait, and overpaid the invoice.
 * 2. A bank line confirmed while the slip for the same transfer was being accepted: the line
 *    looked for an accepted slip before the slip committed, then found the slip no longer
 *    pending, and recorded the money a second time on the next open invoice.
 */
const host = process.env.TEST_PG_HOST;
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const PROPERTY = '22222222-2222-2222-2222-222222222222';
const APPLICANT = '44444444-4444-4444-4444-444444444444';
const LANDLORD_ID = '11111111-1111-1111-1111-111111111111';

let db: typeof import('../lib/db');
let payments: typeof import('../lib/payments');
let admin: pg.Client;
let api: typeof import('../api').handler;
let connection: pg.ClientConfig;

const call = async (method: string, path: string, body?: unknown) => {
  const event = {
    rawPath: path,
    headers: { 'content-type': 'application/json' },
    queryStringParameters: {},
    pathParameters: {},
    body: body ? JSON.stringify(body) : undefined,
    requestContext: {
      http: { method, path, sourceIp: '127.0.0.1', userAgent: 'test' },
      authorizer: { jwt: { claims: { sub: 'sub-landlord', 'cognito:groups': '[landlord]' } } },
    },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
  const result = (await api(event)) as { statusCode: number; body?: string };
  return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : null };
};

/** Resolves once some session is waiting on a row lock, or false after five seconds. */
async function someoneWaits(done: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!done() && Date.now() < deadline) {
    const { rows } = await admin.query<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if (rows[0]!.n > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

let unitNo = 0;
async function makeLease() {
  unitNo += 1;
  const [unit] = await db.query<{ id: string }>(
    `insert into unit (property_id, code, bedrooms, bathrooms, monthly_rent_cents, deposit_cents, status)
     values ($1, $2, 1, 1, 1000000, 1000000, 'occupied') returning id`,
    [PROPERTY, `RACE4-${unitNo}`],
  );
  const [application] = await db.query<{ id: string }>(
    `insert into application (unit_id, applicant_id, status, preferred_move_in)
     values ($1, $2, 'approved', current_date) returning id`,
    [unit!.id, APPLICANT],
  );
  const [lease] = await db.query<{ id: string; ref: string }>(
    `insert into lease (application_id, unit_id, applicant_id, start_date, end_date,
                        monthly_rent_cents, escalation_pct, deposit_cents, status)
     values ($1, $2, $3, '2026-01-01', '2026-12-31', 1000000, 0, 1000000, 'active') returning id`,
    [application!.id, unit!.id, APPLICANT],
  );
  return lease!.id;
}

async function invoice(leaseId: string, period: string, cents: number) {
  const [row] = await db.query<{ id: string }>(
    `insert into invoice (lease_id, period_start, due_on, total_cents) values ($1, $2, $2, $3) returning id`,
    [leaseId, period, cents],
  );
  return row!.id;
}

describe.skipIf(!host)('money recorded twice at once, against Postgres', () => {
  beforeAll(async () => {
    connection = {
      host,
      port: Number(process.env.TEST_PG_PORT ?? 5432),
      user: process.env.TEST_PG_USER ?? 'postgres',
      password: process.env.TEST_PG_PASSWORD ?? 'postgres',
      database: process.env.TEST_PG_DATABASE ?? 'postgres',
    };
    // A database of its own: invoice-run-race resets the public schema of the shared one, and
    // vitest runs the two files at the same time.
    const setup = new pg.Client(connection);
    await setup.connect();
    await setup.query('drop database if exists tms_money_race_4 with (force)');
    await setup.query('create database tms_money_race_4');
    await setup.end();
    connection = { ...connection, database: 'tms_money_race_4' };
    admin = new pg.Client(connection);
    await admin.connect();
    const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
    const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
    for (const file of all.filter((n) => !n.includes('seed'))) await admin.query(read(file));
    for (const file of all.filter((n) => n.includes('seed'))) await admin.query(read(file));

    process.env.NODE_ENV = 'development';
    process.env.DB_DRIVER = 'postgres';
    process.env.DB_SSL = 'off';
    process.env.DB_HOST = connection.host!;
    process.env.DB_PORT = String(connection.port);
    process.env.DB_NAME = connection.database!;
    process.env.DB_USER = connection.user!;
    process.env.DB_PASSWORD = String(connection.password);
    process.env.DB_POOL_MAX = '5';
    process.env.DB_SECRET_ARN = 'unused';
    process.env.DOCS_BUCKET = 'unused';
    process.env.KMS_KEY_ID = 'unused';
    process.env.NOTIFY_MODE = 'skip';
    process.env.STORAGE_DRIVER = 'local';
    process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'tms-storage-'));
    process.env.KMS_DRIVER = 'local';
    db = await import('../lib/db');
    payments = await import('../lib/payments');
    ({ handler: api } = await import('../api'));
  }, 120_000);

  afterAll(async () => {
    await admin?.end();
    await db?.getPool().end();
  });

  it('counts a payment committed while the second allocation waited, and refuses the overpayment', async () => {
    const leaseId = await makeLease();
    const invoiceId = await invoice(leaseId, '2026-08-01', 1000000);

    // The first payment, mid-flight: it holds the invoice and has recorded R5 000.
    const first = new pg.Client(connection);
    await first.connect();
    await first.query('begin');
    await first.query('select id from invoice where id = $1 for update', [invoiceId]);
    await first.query(
      `insert into payment (lease_id, invoice_id, amount_cents, method, received_on, recorded_by)
       values ($1, $2, 500000, 'eft', '2026-08-02', 'test')`,
      [leaseId, invoiceId],
    );
    await first.query(`update invoice set status = 'part_paid' where id = $1`, [invoiceId]);

    let finished = false;
    const second = db
      .withTransaction((run) =>
        payments.allocatePayment(run, {
          leaseId, amountCents: 1000000, method: 'eft', reference: null, receivedOn: '2026-08-03', recordedBy: 'test',
        }),
      )
      .then(
        () => 'recorded',
        (error: Error) => error.message,
      )
      .finally(() => {
        finished = true;
      });
    expect(await someoneWaits(() => finished)).toBe(true);
    await first.query('commit');
    await first.end();

    expect(await second).toMatch(/^That is .* more than the .* owed/);
    const [paid] = await db.query<{ cents: string }>(
      'select coalesce(sum(amount_cents), 0)::text as cents from payment where invoice_id = $1',
      [invoiceId],
    );
    expect(paid!.cents).toBe('500000');
  });

  it('records a manual receipt while a slip on the same lease is being allocated, without a deadlock', async () => {
    const leaseId = await makeLease();
    const invoiceId = await invoice(leaseId, '2026-08-01', 1000000);

    // allocatePayment mid-flight: it holds the lease and is about to lock the open invoices.
    const allocating = new pg.Client(connection);
    await allocating.connect();
    await allocating.query('begin');
    await allocating.query('select id from lease where id = $1 for update', [leaseId]);

    let finished = false;
    const receipt = call('POST', `/leases/${leaseId}/payments`, {
      target: 'invoice', invoiceId, amountCents: 300000, method: 'eft', receivedOn: '2026-08-02',
    }).finally(() => {
      finished = true;
    });
    expect(await someoneWaits(() => finished)).toBe(true);
    // Locked the invoice before the lease, the receipt held it here and waited on the lease for
    // the payment's foreign key, and Postgres killed one of the two.
    await allocating.query('select id from invoice where id = $1 for update', [invoiceId]);
    await allocating.query('commit');
    await allocating.end();

    const recorded = await receipt;
    expect(recorded.status).toBe(201);
    expect(recorded.body).toMatchObject({ invoiceStatus: 'part_paid', paidCents: 300000 });
  });

  it('links a bank line confirmed during the slip’s acceptance to the slip, instead of recording it again', async () => {
    const leaseId = await makeLease();
    const august = await invoice(leaseId, '2026-08-01', 500000);
    const september = await invoice(leaseId, '2026-09-01', 500000);
    const [proof] = await db.query<{ id: string }>(
      `insert into payment_proof (lease_id, target, invoice_id, amount_cents, paid_on, reference, s3_key, content_type,
                                  size_bytes, status, submitted_by, submitted_at)
       values ($1, 'invoice', $2, 500000, '2026-08-02', 'slip', 'proofs/race4.pdf', 'application/pdf', 10, 'pending',
               'sub-tenant', now()) returning id`,
      [leaseId, august],
    );
    const [imported] = await db.query<{ id: string }>(
      `insert into bank_import (landlord_id, file_name, format, imported_by) values ($1, 's.csv', 'csv', 'sub-landlord') returning id`,
      [LANDLORD_ID],
    );
    const [line] = await db.query<{ id: string }>(
      `insert into bank_line (import_id, landlord_id, posted_on, amount_cents, description, fingerprint)
       values ($1, $2, '2026-08-03', 500000, 'RENT', 'fp-race4') returning id`,
      [imported!.id, LANDLORD_ID],
    );

    // The slip's acceptance, mid-flight, taking its locks in the order the handler does.
    const slip = new pg.Client(connection);
    await slip.connect();
    await slip.query('begin');
    await slip.query('select id from lease where id = $1 for update', [leaseId]);
    await slip.query('select id from payment_proof where id = $1 for update', [proof!.id]);
    await slip.query(
      `insert into payment (lease_id, invoice_id, amount_cents, method, received_on, recorded_by, proof_id)
       values ($1, $2, 500000, 'eft', '2026-08-02', 'sub-landlord', $3)`,
      [leaseId, august, proof!.id],
    );
    await slip.query(`update invoice set status = 'paid' where id = $1`, [august]);
    await slip.query(`update payment_proof set status = 'accepted', reviewed_at = now() where id = $1`, [proof!.id]);

    let finished = false;
    const resolving = call('POST', `/bank-imports/${imported!.id}/resolve`, { lines: [{ lineId: line!.id, leaseId }] })
      .finally(() => {
        finished = true;
      });
    expect(await someoneWaits(() => finished)).toBe(true);
    await slip.query('commit');
    await slip.end();

    const resolved = await resolving;
    expect(resolved.status).toBe(200);
    expect(resolved.body.results[0]).toMatchObject({ ok: true });
    const recorded = await db.query<{ invoice_id: string; proof_id: string | null; bank_line_id: string | null }>(
      'select invoice_id, proof_id, bank_line_id from payment where lease_id = $1',
      [leaseId],
    );
    expect(recorded).toEqual([{ invoice_id: august, proof_id: proof!.id, bank_line_id: line!.id }]);
    const [next] = await db.query<{ status: string }>('select status from invoice where id = $1', [september]);
    expect(next!.status).toBe('issued');
  });
});
