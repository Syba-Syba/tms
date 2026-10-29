import { beforeAll, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRIVACY_VERSION } from '../domain/privacy';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const PROPERTY = '22222222-2222-2222-2222-222222222222';

type As = { sub: string; groups: string };
const NOBODY: As = { sub: 'anonymous', groups: 'tenant' };
const OWNER: As = { sub: 'sub-landlord', groups: 'landlord' };
let call: (method: string, path: string, as: As, body?: unknown) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://lifecycle-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.AUTH_DRIVER = 'local';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'tms-lifecycle-'));
  process.env.KMS_DRIVER = 'local';
  db = await import('../lib/db');
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  for (const file of all.filter((n) => !n.includes('seed'))) await db.execScript(read(file));
  for (const file of all.filter((n) => n.includes('seed'))) await db.execScript(read(file));
  const { handler } = await import('../api');
  let ip = 0;
  call = async (method, path, as, body) => {
    const [rawPath, search = ''] = path.split('?');
    const event = {
      rawPath,
      headers: { 'content-type': 'application/json' },
      queryStringParameters: Object.fromEntries(new URLSearchParams(search)),
      pathParameters: {},
      body: body === undefined ? undefined : JSON.stringify(body),
      requestContext: {
        http: { method, path: rawPath, sourceIp: `10.73.0.${(ip++ % 250) + 1}`, userAgent: 'test' },
        authorizer: { jwt: { claims: { sub: as.sub, 'cognito:groups': `[${as.groups}]` } } },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
    const result = (await handler(event)) as { statusCode: number; body?: string };
    return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : null };
  };
}, 120_000);

let units = 0;
async function newUnit(): Promise<string> {
  units += 1;
  const [row] = await db.query<{ id: string }>(
    `insert into unit (property_id, code, bedrooms, bathrooms, monthly_rent_cents, deposit_cents, status)
     values ($1, $2, 1, 1, 700000, 700000, 'vacant') returning id`,
    [PROPERTY, `LC${units}`],
  );
  return row!.id;
}

let people = 0;
async function newApplicant(): Promise<As> {
  people += 1;
  const made = await call('POST', '/auth/register', NOBODY, {
    name: `Lifecycle Person${people}`, email: `lifecycle-${people}@example.co.za`, password: 'a-long-password', consentVersion: PRIVACY_VERSION,
  });
  expect(made.status).toBe(201);
  return { sub: made.body.user.sub, groups: 'tenant' };
}

async function apply(as: As, unitId: string): Promise<string> {
  const applied = await call('POST', '/applications', as, {
    unitId, firstName: 'Lifecycle', lastName: 'Applicant', idNumber: '9001015009086',
    email: 'lifecycle@example.co.za', phone: '0825550123', employmentStatus: 'employed',
    monthlyIncomeCents: 4500000, occupants: 1, preferredMoveIn: '2099-01-01', consentVersion: PRIVACY_VERSION,
  });
  expect(applied.status).toBe(201);
  return applied.body.id;
}

const decide = (id: string, outcome: 'approved' | 'declined') =>
  call('POST', `/applications/${id}/decision`, OWNER, { outcome, reason: outcome === 'declined' ? 'Another applicant.' : undefined });
const generate = (id: string) => call('POST', `/applications/${id}/lease`, OWNER, { startDate: '2099-01-01' });
const withdraw = (id: string, as: As) => call('POST', `/applications/${id}/withdraw`, as);
const unitStatus = async (id: string) =>
  (await db.query<{ status: string }>('select status from unit where id = $1', [id]))[0]!.status;

describe('declining an application', () => {
  it('keeps the unit held while another applicant is approved with a lease out for signature', async () => {
    const unit = await newUnit();
    const first = await apply(await newApplicant(), unit);
    const second = await apply(await newApplicant(), unit);
    expect((await decide(first, 'approved')).status).toBe(200);
    expect((await generate(first)).status).toBe(201);
    expect((await decide(second, 'declined')).status).toBe(200);
    expect(await unitStatus(unit)).toBe('held');
  });

  it('keeps the unit held while another application is still waiting, and frees it after the last', async () => {
    const unit = await newUnit();
    const first = await apply(await newApplicant(), unit);
    const second = await apply(await newApplicant(), unit);
    expect((await decide(second, 'declined')).status).toBe(200);
    expect(await unitStatus(unit)).toBe('held');
    expect((await decide(first, 'declined')).status).toBe(200);
    expect(await unitStatus(unit)).toBe('vacant');
  });
});

describe('approving two applications on one unit', () => {
  it('refuses the second approval', async () => {
    const unit = await newUnit();
    const first = await apply(await newApplicant(), unit);
    const second = await apply(await newApplicant(), unit);
    expect((await decide(first, 'approved')).status).toBe(200);
    const refused = await decide(second, 'approved');
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/already approved/);
    // Declining is still allowed.
    expect((await decide(second, 'declined')).status).toBe(200);
  });

  it('answers a clash on the one-live-lease-per-unit index with a 409, not a 500', async () => {
    const unit = await newUnit();
    const first = await apply(await newApplicant(), unit);
    const second = await apply(await newApplicant(), unit);
    expect((await decide(first, 'approved')).status).toBe(200);
    expect((await generate(first)).status).toBe(201);
    // Data approved before the decide check existed.
    await db.query(`update application set status = 'approved', decided_at = now() where id = $1`, [second]);
    const clash = await generate(second);
    expect(clash.status).toBe(409);
    expect(clash.body.error.message).toMatch(/already has a lease/);
  });
});

describe('withdrawing an application', () => {
  it('lets the applicant withdraw their own waiting application, freeing the unit', async () => {
    const unit = await newUnit();
    const applicant = await newApplicant();
    const id = await apply(applicant, unit);
    expect((await withdraw(id, await newApplicant())).status).toBe(403);
    // The landlord declines one still being considered; withdrawing is the applicant's.
    expect((await withdraw(id, OWNER)).status).toBe(409);

    const done = await withdraw(id, applicant);
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ id, status: 'withdrawn' });
    expect(await unitStatus(unit)).toBe('vacant');
    const [row] = await db.query<{ decided_at: string | null }>('select decided_at from application where id = $1', [id]);
    expect(row!.decided_at).toBeTruthy();
    const audited = await db.query(`select 1 from audit_log where entity_id = $1 and action = 'application.withdrawn'`, [id]);
    expect(audited).toHaveLength(1);
    expect((await withdraw(id, applicant)).status).toBe(409);
  });

  it('cancels a draft lease when the approved applicant withdraws', async () => {
    const unit = await newUnit();
    const applicant = await newApplicant();
    const id = await apply(applicant, unit);
    expect((await decide(id, 'approved')).status).toBe(200);
    const [lease] = await db.query<{ id: string }>(
      `insert into lease (application_id, unit_id, applicant_id, start_date, end_date, monthly_rent_cents, escalation_pct, deposit_cents, status)
       select a.id, a.unit_id, a.applicant_id, '2099-01-01', '2099-12-31', 700000, 8, 700000, 'draft' from application a where a.id = $1
       returning id`,
      [id],
    );
    expect((await withdraw(id, applicant)).status).toBe(200);
    const [after] = await db.query<{ status: string }>('select status from lease where id = $1', [lease!.id]);
    expect(after!.status).toBe('cancelled');
    expect(await unitStatus(unit)).toBe('vacant');
  });

  it('lets the landlord withdraw an approved application whose lease was never signed', async () => {
    const unit = await newUnit();
    const applicant = await newApplicant();
    const id = await apply(applicant, unit);
    const next = await apply(await newApplicant(), unit);
    expect((await decide(id, 'approved')).status).toBe(200);
    const lease = await generate(id);
    expect(lease.status).toBe(201);

    // Out for signature is past the point the applicant can simply walk away.
    expect((await withdraw(id, applicant)).status).toBe(409);
    expect((await withdraw(id, OWNER)).status).toBe(200);
    const [after] = await db.query<{ status: string }>('select status from lease where id = $1', [lease.body.id]);
    expect(after!.status).toBe('cancelled');
    // The other applicant is still waiting, so the unit stays held for them, and can now be approved.
    expect(await unitStatus(unit)).toBe('held');
    expect((await decide(next, 'approved')).status).toBe(200);
    expect((await generate(next)).status).toBe(201);
  });

  it('refuses once the lease is signed', async () => {
    const unit = await newUnit();
    const applicant = await newApplicant();
    const id = await apply(applicant, unit);
    expect((await decide(id, 'approved')).status).toBe(200);
    const lease = await generate(id);
    await db.query(`update lease set status = 'active' where id = $1`, [lease.body.id]);
    expect((await withdraw(id, OWNER)).status).toBe(409);
  });
});

describe('privacy sweep', () => {
  it('removes the paperwork of applications left undecided, or approved with no lease, for a year', async () => {
    const ids: Record<string, string> = {};
    for (const name of ['idle', 'fresh', 'approvedOld', 'approvedLeased']) {
      ids[name] = await apply(await newApplicant(), await newUnit());
      await db.query(
        `insert into application_document (application_id, kind, s3_key, content_type, size_bytes)
         values ($1, 'payslip', $2, 'application/pdf', 10)`,
        [ids[name], `applications/${ids[name]}/payslip/p.pdf`],
      );
    }
    await db.query(`update application set updated_at = now() - interval '13 months' where id = $1`, [ids.idle]);
    for (const name of ['approvedOld', 'approvedLeased']) {
      await db.query(
        `update application set status = 'approved', decided_at = now() - interval '13 months', updated_at = now() - interval '13 months' where id = $1`,
        [ids[name]],
      );
    }
    await db.query(
      `insert into lease (application_id, unit_id, applicant_id, start_date, end_date, monthly_rent_cents, escalation_pct, deposit_cents, status)
       select a.id, a.unit_id, a.applicant_id, '2025-01-01', '2025-12-31', 700000, 8, 700000, 'terminated' from application a where a.id = $1`,
      [ids.approvedLeased],
    );

    const { handler } = await import('../handlers/privacy-sweep');
    await handler();
    const left = async (id: string) => (await db.query('select 1 from application_document where application_id = $1', [id])).length;
    expect(await left(ids.idle!)).toBe(0);
    expect(await left(ids.approvedOld!)).toBe(0);
    expect(await left(ids.fresh!)).toBe(1);
    // A tenant's paperwork follows the lease retention rule, not this one.
    expect(await left(ids.approvedLeased!)).toBe(1);
  });
});
