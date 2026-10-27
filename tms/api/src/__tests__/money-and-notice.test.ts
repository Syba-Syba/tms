import { beforeAll, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const LEASE = '66666666-6666-6666-6666-666666666666';

/** Payments recorded once, notice rules by who serves it, and billing trimmed to the end date. */
type Opts = { sub?: string; groups?: string; body?: unknown };
let call: (method: string, path: string, opts?: Opts) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let dates: typeof import('../domain/dates');

const tenant: Opts = { sub: 'sub-tenant', groups: 'tenant' };

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://money-notice-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'tms-storage-'));
  process.env.KMS_DRIVER = 'local';

  db = await import('../lib/db');
  dates = await import('../domain/dates');
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  for (const file of all.filter((n) => !n.includes('seed'))) await db.execScript(read(file));
  for (const file of all.filter((n) => n.includes('seed'))) await db.execScript(read(file));

  const { handler } = await import('../api');
  call = async (method, path, opts = {}) => {
    const event = {
      rawPath: path,
      headers: { 'content-type': 'application/json' },
      queryStringParameters: {},
      pathParameters: {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      requestContext: {
        http: { method, path, sourceIp: '127.0.0.1', userAgent: 'test' },
        authorizer: {
          jwt: { claims: { sub: opts.sub ?? 'sub-landlord', 'cognito:groups': `[${opts.groups ?? 'landlord'}]` } },
        },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
    const result = (await handler(event)) as { statusCode: number; body?: string };
    return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : null };
  };
}, 120_000);

describe('recording a payment', () => {
  let invoiceId: string;

  beforeAll(async () => {
    const [invoice] = await db.query<{ id: string }>(
      `insert into invoice (lease_id, period_start, due_on, total_cents)
       values ($1, '2001-01-01', '2001-01-01', 850000) returning id`,
      [LEASE],
    );
    invoiceId = invoice!.id;
  });

  it('records one payment for one idempotency key, however often it is sent', async () => {
    const body = {
      target: 'invoice',
      invoiceId,
      amountCents: 100000,
      receivedOn: dates.sastToday(),
      idempotencyKey: 'pay-key-0001',
    };
    const first = await call('POST', `/leases/${LEASE}/payments`, { body });
    const second = await call('POST', `/leases/${LEASE}/payments`, { body });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    const rows = await db.query('select id from payment where invoice_id = $1', [invoiceId]);
    expect(rows).toHaveLength(1);
  });

  it('refuses a payment received in the future', async () => {
    const response = await call('POST', `/leases/${LEASE}/payments`, {
      body: { target: 'invoice', invoiceId, amountCents: 1000, receivedOn: dates.addDaysIso(dates.sastToday(), 2) },
    });
    expect(response.status).toBe(400);
  });
});

describe('serving notice', () => {
  it('does not let a tenant serve notice for their own breach', async () => {
    const response = await call('POST', `/leases/${LEASE}/termination`, {
      ...tenant,
      body: { initiatedBy: 'tenant', reason: 'breach_by_tenant' },
    });
    expect(response.status).toBe(400);
  });

  it('does not let a landlord backdate notice by more than a month', async () => {
    const response = await call('POST', `/leases/${LEASE}/termination`, {
      body: { initiatedBy: 'landlord', reason: 'breach_by_tenant', noticeGivenOn: dates.addDaysIso(dates.sastToday(), -60) },
    });
    expect(response.status).toBe(400);
  });

  it("dates a tenant's notice today, voids invoices after the end date, and keeps the rest", async () => {
    const future = dates.nextMonthStart(dates.addDaysIso(dates.sastToday(), 120));
    const [later] = await db.query<{ id: string }>(
      `insert into invoice (lease_id, period_start, due_on, total_cents, covers_from, covers_to)
       values ($1, $2, $2, 850000, $2, ($2::date + interval '1 month' - interval '1 day')::date) returning id`,
      [LEASE, future],
    );

    const response = await call('POST', `/leases/${LEASE}/termination`, {
      ...tenant,
      body: { initiatedBy: 'tenant', reason: 'early_tenant', noticeGivenOn: '2001-01-01' },
    });
    expect(response.status).toBe(201);

    const [termination] = await db.query<{ notice_given_on: string; effective_on: string }>(
      'select notice_given_on::text, effective_on::text from termination where lease_id = $1',
      [LEASE],
    );
    expect(termination!.notice_given_on).toBe(dates.sastToday());
    expect(termination!.effective_on < future).toBe(true);

    const [after] = await db.query<{ status: string }>('select status from invoice where id = $1', [later!.id]);
    expect(after!.status).toBe('void');
    const [old] = await db.query<{ status: string }>(
      `select status from invoice where lease_id = $1 and period_start = '2001-01-01'`,
      [LEASE],
    );
    expect(old!.status).not.toBe('void');
  });
});
