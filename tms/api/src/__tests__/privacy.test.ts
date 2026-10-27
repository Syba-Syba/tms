import { beforeAll, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRIVACY_VERSION } from '../domain/privacy';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

/** POPIA: consent on record, a full export, and erasure that respects the retention period. */
type As = { sub: string; groups: string };
const LANDLORD: As = { sub: 'sub-landlord', groups: 'landlord' };
const OTHER: As = { sub: 'sub-landlord-two', groups: 'landlord' };
const TENANT: As = { sub: 'sub-tenant', groups: 'tenant' };
const UNIT_B1 = '33333333-3333-3333-3333-333333333335';

let call: (method: string, path: string, as: As | null, body?: unknown) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let storage: typeof import('../lib/storage');

const register = async (name: string, email: string, consentVersion?: string) => {
  const made = await call('POST', '/auth/register', null, { name, email, password: 'long-enough-1', consentVersion });
  return { status: made.status, as: made.body?.user ? { sub: made.body.user.sub as string, groups: 'tenant' } : null };
};

const apply = (as: As, body: Record<string, unknown> = {}) =>
  call('POST', '/applications', as, {
    unitId: UNIT_B1, firstName: 'Lerato', lastName: 'Nkosi', idNumber: '9001015009086',
    email: 'lerato@example.co.za', phone: '0825550123', employmentStatus: 'employed',
    monthlyIncomeCents: 4500000, occupants: 1, preferredMoveIn: '2099-01-01', consentVersion: PRIVACY_VERSION,
    ...body,
  });

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://privacy-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.AUTH_DRIVER = 'local';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'tms-privacy-'));
  process.env.KMS_DRIVER = 'local';

  db = await import('../lib/db');
  storage = await import('../lib/storage');
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  for (const file of all.filter((n) => !n.includes('seed'))) await db.execScript(read(file));
  for (const file of all.filter((n) => n.includes('seed'))) await db.execScript(read(file));
  await db.query(
    `insert into landlord (trading_name, email, phone, cognito_sub) values ('Other', 'o@example.co.za', '0820000000', $1)`,
    [OTHER.sub],
  );

  const { handler } = await import('../api');
  call = async (method, path, as, body) => {
    const event = {
      rawPath: path,
      headers: { 'content-type': 'application/json' },
      queryStringParameters: {},
      pathParameters: {},
      body: body ? JSON.stringify(body) : undefined,
      requestContext: {
        http: { method, path, sourceIp: '10.7.0.1', userAgent: 'privacy-test' },
        authorizer: { jwt: { claims: { sub: as?.sub ?? 'anonymous', 'cognito:groups': `[${as?.groups ?? 'tenant'}]` } } },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
    const result = (await handler(event)) as { statusCode: number; body?: string };
    return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : null };
  };
}, 120_000);

describe('consent', () => {
  it('records the notice version at sign-up, with where it came from', async () => {
    const { status, as } = await register('Consenting Person', 'consent@example.co.za', PRIVACY_VERSION);
    expect(status).toBe(201);
    const [row] = await db.query<{ version: string; ip_address: string; user_agent: string }>(
      `select version, ip_address, user_agent from consent where person_sub = $1 and kind = 'privacy_notice'`,
      [as!.sub],
    );
    expect(row).toEqual({ version: PRIVACY_VERSION, ip_address: '10.7.0.1', user_agent: 'privacy-test' });
    expect((await call('GET', '/me/privacy', as)).body.acceptedVersion).toBe(PRIVACY_VERSION);
  });

  it('refuses an outdated version, and asks an account without consent to give it', async () => {
    expect((await register('Old Notice', 'old@example.co.za', '2001-01-01')).status).toBe(400);
    const { as } = await register('No Consent Yet', 'later@example.co.za');
    expect((await call('GET', '/me/privacy', as)).body).toMatchObject({ currentVersion: PRIVACY_VERSION, acceptedVersion: null });
    expect((await call('POST', '/me/consents', as, { version: '2001-01-01' })).status).toBe(400);
    expect((await call('POST', '/me/consents', as, { version: PRIVACY_VERSION })).status).toBe(201);
    expect((await call('GET', '/me/privacy', as)).body.acceptedVersion).toBe(PRIVACY_VERSION);
  });

  it('needs consent to apply, and records it against the application', async () => {
    const { as } = await register('Applicant One', 'applicant1@example.co.za', PRIVACY_VERSION);
    expect((await apply(as!, { consentVersion: undefined })).status).toBe(400);
    const made = await apply(as!);
    expect(made.status).toBe(201);
    const [row] = await db.query<{ subject_id: string }>(
      `select subject_id from consent where person_sub = $1 and kind = 'application_screening'`,
      [as!.sub],
    );
    expect(row!.subject_id).toBe(made.body.id);
  });
});

describe('export', () => {
  it('gives a person everything held about them, and nothing secret', async () => {
    const exported = await call('GET', '/me/data-export', TENANT);
    expect(exported.status).toBe(200);
    expect(exported.body.applicant).toMatchObject({ first_name: 'Naledi', idNumber: 'ending 0086' });
    expect(exported.body.leases).toHaveLength(1);
    const text = JSON.stringify(exported.body);
    expect(text).not.toContain('password');
    expect(text).not.toContain('id_number_enc');
  });
});

describe('erasure', () => {
  it('deletes an account straight away when it never applied for anything', async () => {
    const { as } = await register('Just Looking', 'looking@example.co.za', PRIVACY_VERSION);
    const done = await call('POST', '/me/erasure-request', as, {});
    expect(done.body.status).toBe('completed');
    const login = await call('POST', '/auth/login', null, { email: 'looking@example.co.za', password: 'long-enough-1' });
    expect(login.status).toBe(401);
  });

  it('does not let a landlord erase their own account from here', async () => {
    expect((await call('POST', '/me/erasure-request', LANDLORD, {})).status).toBe(403);
  });

  it('lets the landlord erase a declined applicant, files and all', async () => {
    const { as } = await register('Declined Person', 'declined@example.co.za', PRIVACY_VERSION);
    const application = await apply(as!, { email: 'declined@example.co.za', firstName: 'Zanele' });
    const key = `applications/${application.body.id}/id_copy/erase-me.pdf`;
    await db.query(
      `insert into application_document (application_id, kind, s3_key, content_type, size_bytes)
       values ($1, 'id_copy', $2, 'application/pdf', 10)`,
      [application.body.id, key],
    );
    await storage.storage().put(key, new Uint8Array([1, 2, 3]), 'application/pdf');
    await call('POST', `/applications/${application.body.id}/decision`, LANDLORD, { outcome: 'declined', reason: 'Unit let to someone else.' });

    const asked = await call('POST', '/me/erasure-request', as, { note: 'Please remove my documents.' });
    expect(asked.status).toBe(201);
    expect((await call('POST', '/me/erasure-request', as, {})).status).toBe(409);

    const queue = await call('GET', '/privacy-requests', LANDLORD);
    const request = queue.body.items.find((item: { email: string }) => item.email === 'declined@example.co.za');
    expect(request).toMatchObject({ status: 'pending', blockedBecause: null, note: 'Please remove my documents.' });
    expect((await call('GET', '/privacy-requests', OTHER)).body.items).toHaveLength(0);
    expect((await call('POST', `/privacy-requests/${request.id}/decision`, OTHER, { decision: 'erase' })).status).toBe(404);

    expect((await call('POST', `/privacy-requests/${request.id}/decision`, LANDLORD, { decision: 'erase' })).status).toBe(200);
    const [person] = await db.query<{ first_name: string; email: string; cognito_sub: string | null }>(
      'select first_name, email, cognito_sub from applicant where id = (select applicant_id from application where id = $1)',
      [application.body.id],
    );
    expect(person).toMatchObject({ first_name: 'Erased', cognito_sub: null });
    expect(person!.email).toMatch(/@invalid$/);
    expect(existsSync(storage.localPathFor(key))).toBe(false);
    expect(await db.query('select 1 from application_document where application_id = $1', [application.body.id])).toHaveLength(0);
    const [told] = await db.query<{ recipient_to: string; subject: string }>(
      `select recipient_to, subject from notification where kind = 'privacy_request' and recipient_sub = $1`,
      [as!.sub],
    );
    expect(told).toEqual({ recipient_to: 'declined@example.co.za', subject: 'Your information has been erased' });
    // The application row stays, so the landlord's history still adds up.
    expect(await db.query('select 1 from application where id = $1', [application.body.id])).toHaveLength(1);
  });

  it('will not erase a tenant inside the retention period, and makes a refusal explain itself', async () => {
    expect((await call('GET', '/me/privacy', TENANT)).body.erasureBlockedBecause).toMatch(/must be kept until/);
    await call('POST', '/me/erasure-request', TENANT, {});
    const queue = await call('GET', '/privacy-requests', LANDLORD);
    const request = queue.body.items.find((item: { email: string }) => item.email === 'naledi@example.co.za');
    expect(request.blockedBecause).toMatch(/five years/);

    const erase = await call('POST', `/privacy-requests/${request.id}/decision`, LANDLORD, { decision: 'erase' });
    expect(erase.status).toBe(409);
    expect((await call('POST', `/privacy-requests/${request.id}/decision`, LANDLORD, { decision: 'refuse', response: 'no' })).status).toBe(400);
    const refused = await call('POST', `/privacy-requests/${request.id}/decision`, LANDLORD, {
      decision: 'refuse', response: 'Your lease is still running, and its records are kept for five years after it ends.',
    });
    expect(refused.status).toBe(200);
    const [row] = await db.query<{ first_name: string }>(`select first_name from applicant where cognito_sub = 'sub-tenant'`);
    expect(row!.first_name).toBe('Naledi');
  });
});

describe('retention sweep', () => {
  it('purges paperwork of applicants declined over a year ago, and keeps the rest', async () => {
    const { as } = await register('Old Applicant', 'old-applicant@example.co.za', PRIVACY_VERSION);
    const old = await apply(as!, { email: 'old-applicant@example.co.za' });
    const recent = await apply(as!, { email: 'old-applicant@example.co.za' });
    for (const id of [old.body.id, recent.body.id]) {
      await db.query(
        `insert into application_document (application_id, kind, s3_key, content_type, size_bytes)
         values ($1, 'payslip', $2, 'application/pdf', 10)`,
        [id, `applications/${id}/payslip/p.pdf`],
      );
    }
    await db.query(`update application set status = 'declined', decided_at = now() - interval '13 months' where id = $1`, [old.body.id]);
    await db.query(`update application set status = 'declined', decided_at = now() - interval '2 months' where id = $1`, [recent.body.id]);

    const { handler } = await import('../handlers/privacy-sweep');
    const result = await handler();
    expect(result.removed).toBeGreaterThanOrEqual(1);
    expect(await db.query('select 1 from application_document where application_id = $1', [old.body.id])).toHaveLength(0);
    expect(await db.query('select 1 from application_document where application_id = $1', [recent.body.id])).toHaveLength(1);
  });
});
