import { beforeAll, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

/** Expenses and the two reports built on them, with a second landlord to prove isolation. */
type As = { sub: string; groups: string };
const LANDLORD: As = { sub: 'sub-landlord', groups: 'landlord' };
const OTHER: As = { sub: 'sub-landlord-two', groups: 'landlord' };
const TENANT: As = { sub: 'sub-tenant', groups: 'tenant' };
const LEASE = '66666666-6666-6666-6666-666666666666';
const PROPERTY = '22222222-2222-2222-2222-222222222222';

let call: (method: string, path: string, as: As, body?: unknown) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let otherProperty: string;

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://expenses-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'tms-expenses-'));
  process.env.KMS_DRIVER = 'local';

  db = await import('../lib/db');
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  for (const file of all.filter((n) => !n.includes('seed'))) await db.execScript(read(file));
  for (const file of all.filter((n) => n.includes('seed'))) await db.execScript(read(file));
  const [other] = await db.query<{ id: string }>(
    `insert into landlord (trading_name, email, phone, cognito_sub)
     values ('Dlamini Rentals', 'two@example.co.za', '+27829999999', $1) returning id`,
    [OTHER.sub],
  );
  const [property] = await db.query<{ id: string }>(
    `insert into property (landlord_id, name, address_line1, suburb, city, province, postal_code)
     values ($1, 'Second Court', '9 Other Road', 'Parkview', 'Johannesburg', 'Gauteng', '2193') returning id`,
    [other!.id],
  );
  otherProperty = property!.id;

  // Two months of rent: September paid in full, October still owed.
  for (const [period, due] of [['2026-09-01', '2026-09-07'], ['2026-10-01', '2026-10-07']]) {
    const [invoice] = await db.query<{ id: string }>(
      `insert into invoice (lease_id, period_start, due_on, total_cents, status)
       values ($1, $2, $3, 850000, $4) returning id`,
      [LEASE, period, due, period === '2026-09-01' ? 'paid' : 'issued'],
    );
    if (period === '2026-09-01') {
      await db.query(
        `insert into payment (lease_id, invoice_id, amount_cents, method, received_on, recorded_by)
         values ($1, $2, 850000, 'eft', '2026-09-05', 'sub-landlord')`,
        [LEASE, invoice!.id],
      );
    }
  }

  const { handler } = await import('../api');
  call = async (method, path, as, body) => {
    const [rawPath, rawQuery] = path.split('?');
    const event = {
      rawPath,
      headers: { 'content-type': 'application/json' },
      queryStringParameters: Object.fromEntries(new URLSearchParams(rawQuery ?? '')),
      pathParameters: {},
      body: body ? JSON.stringify(body) : undefined,
      requestContext: {
        http: { method, path: rawPath, sourceIp: '127.0.0.1', userAgent: 'test' },
        authorizer: { jwt: { claims: { sub: as.sub, 'cognito:groups': `[${as.groups}]` } } },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
    const result = (await handler(event)) as { statusCode: number; body?: string };
    return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : null };
  };
}, 120_000);

describe('expenses', () => {
  let rates: string;

  it('records an expense with a slip, and only its landlord can open the slip', async () => {
    const created = await call('POST', '/expenses', LANDLORD, {
      propertyId: PROPERTY, category: 'rates', description: 'City of Joburg rates, September',
      amountCents: 120000, incurredOn: '2026-09-15', slip: { contentType: 'application/pdf', sizeBytes: 2000 },
    });
    expect(created.status).toBe(201);
    expect(created.body.uploadUrl).toContain('/files/expenses/');
    rates = created.body.id;

    const [row] = await db.query<{ slip_s3_key: string }>('select slip_s3_key from expense where id = $1', [rates]);
    expect((await call('POST', '/files/view', LANDLORD, { key: row!.slip_s3_key })).status).toBe(200);
    expect((await call('POST', '/files/view', OTHER, { key: row!.slip_s3_key })).status).toBe(404);
    expect((await call('POST', '/files/view', TENANT, { key: row!.slip_s3_key })).status).toBe(404);
  });

  it('refuses another landlord\'s property, and tenants', async () => {
    const theirs = await call('POST', '/expenses', LANDLORD, {
      propertyId: otherProperty, category: 'repairs', description: 'Not mine', amountCents: 100, incurredOn: '2026-09-01',
    });
    expect(theirs.status).toBe(400);
    const tenant = await call('POST', '/expenses', TENANT, {
      category: 'other', description: 'Nope', amountCents: 100, incurredOn: '2026-09-01',
    });
    expect(tenant.status).toBe(403);
  });

  it('lists, edits and deletes only the caller\'s own', async () => {
    await call('POST', '/expenses', LANDLORD, {
      category: 'bank_charges', description: 'Monthly account fee', amountCents: 9500, incurredOn: '2026-10-01',
    });
    const mine = await call('GET', '/expenses?from=2026-09-01&to=2026-10-31', LANDLORD);
    expect(mine.body.items).toHaveLength(2);
    expect((await call('GET', '/expenses', OTHER)).body.items).toHaveLength(0);

    const edit = {
      propertyId: PROPERTY, category: 'rates', description: 'Rates, corrected', amountCents: 125000, incurredOn: '2026-09-15',
    };
    expect((await call('PUT', `/expenses/${rates}`, OTHER, edit)).status).toBe(404);
    expect((await call('PUT', `/expenses/${rates}`, LANDLORD, edit)).status).toBe(200);
    expect((await call('DELETE', `/expenses/${rates}`, OTHER)).status).toBe(404);
  });
});

describe('income against expenses', () => {
  it('splits income and costs by property, with unassigned costs on their own line', async () => {
    const report = await call('GET', '/reports/income-expense?from=2026-09-01&to=2026-10-31', LANDLORD);
    expect(report.status).toBe(200);
    const court = report.body.items.find((item: { propertyId: string }) => item.propertyId === PROPERTY);
    expect(court).toMatchObject({ invoicedCents: 1700000, collectedCents: 850000, expensesCents: 125000, netCents: 725000 });
    expect(court.expenseCents.rates).toBe(125000);
    const loose = report.body.items.find((item: { propertyId: string | null }) => item.propertyId === null);
    expect(loose.expenseCents.bank_charges).toBe(9500);
    expect(report.body.totals).toMatchObject({ collectedCents: 850000, expensesCents: 134500, netCents: 715500 });
  });

  it('defaults to the current tax year and refuses a backwards range', async () => {
    const report = await call('GET', '/reports/income-expense', LANDLORD);
    expect(report.body.from.slice(5)).toBe('03-01');
    expect((await call('GET', '/reports/income-expense?from=2026-10-01&to=2026-09-01', LANDLORD)).status).toBe(400);
  });

  it('shows another landlord nothing of this one', async () => {
    const report = await call('GET', '/reports/income-expense?from=2026-09-01&to=2026-10-31', OTHER);
    expect(report.body.totals).toMatchObject({ invoicedCents: 0, collectedCents: 0, expensesCents: 0 });
  });
});

describe('arrears', () => {
  it('shows a tenant with paid months behind them as owing this one', async () => {
    // September is paid, October is not. The old figure subtracted September's payment from
    // October's invoice and called the lease paid up.
    const leases = await call('GET', '/leases', LANDLORD);
    const lease = leases.body.items.find((item: { id: string }) => item.id === LEASE);
    expect(lease.outstandingCents).toBe(850000);
  });

  it('ages what each lease owes', async () => {
    const report = await call('GET', '/reports/arrears', LANDLORD);
    expect(report.status).toBe(200);
    expect(report.body.items).toHaveLength(1);
    expect(report.body.items[0]).toMatchObject({ leaseRef: 'LSE-00101', totalCents: 850000, oldestDueOn: '2026-10-07' });
    expect(report.body.totals.totalCents).toBe(850000);
    expect((await call('GET', '/reports/arrears', OTHER)).body.items).toHaveLength(0);
    expect((await call('GET', '/reports/arrears', TENANT)).status).toBe(403);
  });
});
