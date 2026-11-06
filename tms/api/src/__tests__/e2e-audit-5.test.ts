import { beforeAll, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const PROPERTY = '22222222-2222-2222-2222-222222222222';

/** Found by driving the built app end to end after audit 5.
    Each test names the screen flow that failed.
 */
type Opts = { sub?: string; groups?: string; body?: unknown; query?: Record<string, string> };
let call: (method: string, path: string, opts?: Opts) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let dates: typeof import('../domain/dates');

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://e2e-audit-5-${Date.now()}`;
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
      queryStringParameters: opts.query ?? {},
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

const today = () => dates.sastToday();
const plus = (days: number) => dates.addDaysIso(today(), days);
const asTenant = (sub: string) => ({ sub, groups: 'tenant' });

async function leaseFor(opts: { start: string; end: string; tenantSub?: string; unit?: string; previous?: string; applicant?: string; status?: string }) {
  const unit = opts.unit ?? randomUUID();
  const applicant = opts.applicant ?? randomUUID();
  const application = randomUUID();
  const lease = randomUUID();
  if (!opts.unit) {
    await db.query(
      `insert into unit (id, property_id, code, bedrooms, bathrooms, monthly_rent_cents, deposit_cents, status)
       values ($1, $2, $3, 1, 1, 700000, 700000, 'occupied')`,
      [unit, PROPERTY, `T${unit.slice(0, 5)}`],
    );
  }
  if (!opts.applicant) {
    await db.query(
      `insert into applicant (id, cognito_sub, first_name, last_name, id_number_enc, id_number_last4,
                              email, phone, employment_status, monthly_income_cents)
       values ($1, $2, 'Thandi', 'Tenant', '\\x00', '0001', $3, '+27820000000', 'employed', 2000000)`,
      [applicant, opts.tenantSub ?? null, `t-${applicant.slice(0, 6)}@example.co.za`],
    );
  }
  await db.query(
    `insert into application (id, unit_id, applicant_id, status, preferred_move_in)
     values ($1, $2, $3, 'approved', $4)`,
    [application, unit, applicant, opts.start],
  );
  await db.query(
    `insert into lease (id, application_id, unit_id, applicant_id, start_date, end_date,
                        monthly_rent_cents, escalation_pct, deposit_cents, status, previous_lease_id)
     values ($1, $2, $3, $4, $5, $6, 700000, 0, 700000, $8, $7)`,
    [lease, application, unit, applicant, opts.start, opts.end, opts.previous ?? null, opts.status ?? 'active'],
  );
  return { unit, applicant, application, lease };
}

describe('a landlord records a tenant’s written notice that reached them weeks ago (e2e, flow d)', () => {
  it('with no end date chosen, the lease ends today rather than the request being refused', async () => {
    // The form says the earliest lawful date is worked out; from 30 days back it is already past.
    const tenantSub = `sub-${randomUUID()}`;
    const { lease } = await leaseFor({ start: plus(-100), end: plus(265), tenantSub });
    const served = await call('POST', `/leases/${lease}/termination`, {
      body: { initiatedBy: 'tenant', reason: 'early_tenant', noticeGivenOn: plus(-30) },
    });
    expect(served.status).toBe(201);
    expect(served.body.effectiveOn).toBe(today());
  });

  it('an end date the landlord picks before today is still refused', async () => {
    const { lease } = await leaseFor({ start: plus(-100), end: plus(265), tenantSub: `sub-${randomUUID()}` });
    const served = await call('POST', `/leases/${lease}/termination`, {
      body: { initiatedBy: 'tenant', reason: 'early_tenant', noticeGivenOn: plus(-30), effectiveOn: plus(-1) },
    });
    expect(served.status).toBe(400);
  });
});

describe('the inspection overview says who may reopen it (e2e, flow e)', () => {
  it('not the tenant on an exit report the landlord signed alone after a booked date the tenant missed', async () => {
    const tenantSub = `sub-${randomUUID()}`;
    const { lease } = await leaseFor({ start: plus(-100), end: plus(265), tenantSub });
    // Booked before the day, held yesterday, signed by the landlord alone on the day.
    const [row] = await db.query<{ id: string }>(
      `insert into inspection (lease_id, kind, status, scheduled_for, created_at)
       values ($1, 'outgoing', 'awaiting_signatures', $2::date, ($2::date - 5)::timestamptz) returning id`,
      [lease, plus(-1)],
    );
    await db.query(
      `insert into inspection_signature (inspection_id, party, signed_at, signature_s3_key, pdf_sha256)
       values ($1, 'landlord', ($2::date)::timestamptz + interval '10 hours', 'k', 'h')`,
      [row!.id, plus(-1)],
    );
    const tenantView = await call('GET', `/inspections/${row!.id}`, asTenant(tenantSub));
    expect(tenantView.body.reopenable).toBe(false);
    expect((await call('POST', `/inspections/${row!.id}/reopen`, asTenant(tenantSub))).status).toBe(409);
    expect((await call('GET', `/inspections/${row!.id}`)).body.reopenable).toBe(true);
  });

  it('either party while one signature is on an ordinary report, and nobody once both have signed', async () => {
    const tenantSub = `sub-${randomUUID()}`;
    const { lease } = await leaseFor({ start: plus(-100), end: plus(265), tenantSub });
    const [row] = await db.query<{ id: string }>(
      `insert into inspection (lease_id, kind, status, scheduled_for) values ($1, 'incoming', 'awaiting_signatures', $2) returning id`,
      [lease, today()],
    );
    await db.query(
      `insert into inspection_signature (inspection_id, party, signature_s3_key, pdf_sha256) values ($1, 'landlord', 'k', 'h')`,
      [row!.id],
    );
    expect((await call('GET', `/inspections/${row!.id}`, asTenant(tenantSub))).body.reopenable).toBe(true);
    expect((await call('GET', `/inspections/${row!.id}`)).body.reopenable).toBe(true);
    await db.query(
      `insert into inspection_signature (inspection_id, party, signature_s3_key, pdf_sha256) values ($1, 'tenant', 'k', 'h')`,
      [row!.id],
    );
    expect((await call('GET', `/inspections/${row!.id}`, asTenant(tenantSub))).body.reopenable).toBe(false);
    expect((await call('GET', `/inspections/${row!.id}`)).body.reopenable).toBe(false);
  });
});
