import { beforeAll, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TERMS_VERSION } from '../domain/company';
import { PRIVACY_VERSION } from '../domain/privacy';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const ONE_PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

type As = { sub: string; groups: string };
const NOBODY: As = { sub: 'anonymous', groups: 'tenant' };
const OWNER: As = { sub: 'sub-landlord', groups: 'landlord' };
let call: (method: string, path: string, as: As, body?: unknown) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let storage: typeof import('../lib/storage');

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://credit-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.AUTH_DRIVER = 'local';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'tms-credit-'));
  process.env.KMS_DRIVER = 'local';
  db = await import('../lib/db');
  storage = await import('../lib/storage');
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
        http: { method, path: rawPath, sourceIp: `10.72.0.${(ip++ % 250) + 1}`, userAgent: 'test' },
        authorizer: { jwt: { claims: { sub: as.sub, 'cognito:groups': `[${as.groups}]` } } },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
    const result = (await handler(event)) as { statusCode: number; body?: string };
    return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : null };
  };

}, 120_000);


const UNIT_B1 = '33333333-3333-3333-3333-333333333335';
let applicant: As;
let applicationId: string;
const RESULT = {
  bureau: 'transunion', checkedOn: '2026-10-20', score: 655, outcome: 'minor', judgements: 0, defaults: 1,
  notes: 'One retail account paid late in 2024, settled since.', reportKey: null,
};

const presignReport = (as: As) =>
  call('POST', `/applications/${applicationId}/documents/presign`, as, { kind: 'credit_report', contentType: 'application/pdf', sizeBytes: 900 });

describe('credit checks', () => {
  it('start without agreement, and refuse to be recorded without it', async () => {
    const made = await call('POST', '/auth/register', NOBODY, {
      name: 'Credit Applicant', email: 'credit-applicant@example.co.za', password: 'a-long-password', consentVersion: PRIVACY_VERSION,
    });
    applicant = { sub: made.body.user.sub, groups: 'tenant' };
    const applied = await call('POST', '/applications', applicant, {
      unitId: UNIT_B1, firstName: 'Credit', lastName: 'Applicant', idNumber: '9001015009086',
      email: 'credit-applicant@example.co.za', phone: '0825550123', employmentStatus: 'employed',
      monthlyIncomeCents: 4500000, occupants: 1, preferredMoveIn: '2099-01-01', consentVersion: PRIVACY_VERSION,
    });
    expect(applied.status).toBe(201);
    applicationId = applied.body.id;

    const state = await call('GET', `/applications/${applicationId}/credit-check`, OWNER);
    expect(state.body).toEqual({ consent: null, check: null });
    expect((await call('POST', `/applications/${applicationId}/credit-check`, OWNER, RESULT)).status).toBe(409);
    expect((await presignReport(OWNER)).status).toBe(400);
  });

  it('takes the applicant\'s agreement, on the current notice only', async () => {
    expect((await call('POST', `/applications/${applicationId}/credit-check`, applicant, { consent: true, version: '2020-01-01' })).status).toBe(400);
    const agreed = await call('POST', `/applications/${applicationId}/credit-check`, applicant, { consent: true, version: PRIVACY_VERSION });
    expect(agreed.status).toBe(201);
    expect(agreed.body.consent.acceptedAt).toBeTruthy();
  });

  it('records the result with the report, which only the landlord files', async () => {
    expect((await presignReport(applicant)).status).toBe(400);
    const presigned = await presignReport(OWNER);
    expect(presigned.status).toBe(201);
    await storage.storage().put(presigned.body.key, Buffer.from('%PDF-1.4 bureau report'), 'application/pdf');
    expect((await call('POST', `/applications/${applicationId}/documents/confirm`, OWNER, { key: presigned.body.key })).status).toBe(200);

    expect((await call('POST', `/applications/${applicationId}/credit-check`, OWNER, { ...RESULT, score: 1200 })).status).toBe(400);
    expect((await call('POST', `/applications/${applicationId}/credit-check`, OWNER, { ...RESULT, checkedOn: '2099-01-01' })).status).toBe(400);
    expect((await call('POST', `/applications/${applicationId}/credit-check`, OWNER, { ...RESULT, reportKey: 'applications/x/credit_report/y.pdf' })).status).toBe(400);
    const saved = await call('POST', `/applications/${applicationId}/credit-check`, OWNER, { ...RESULT, reportKey: presigned.body.key });
    expect(saved.status).toBe(200);

    // The applicant sees what was recorded about them, report included.
    const seen = await call('GET', `/applications/${applicationId}/credit-check`, applicant);
    expect(seen.body.check).toMatchObject({ bureau: 'transunion', score: 655, outcome: 'minor', defaults: 1, reportKey: presigned.body.key });
    const [audit] = await db.query<{ action: string }>(
      `select action from audit_log where entity_id = $1 and action = 'application.credit_checked'`, [applicationId],
    );
    expect(audit).toBeTruthy();
  });

  it('keeps other landlords and other people out', async () => {
    const stranger = await call('POST', '/auth/register', NOBODY, {
      name: 'Stranger', email: 'credit-stranger@example.co.za', password: 'a-long-password', consentVersion: PRIVACY_VERSION,
    });
    const outsider: As = { sub: stranger.body.user.sub, groups: 'tenant' };
    expect((await call('GET', `/applications/${applicationId}/credit-check`, outsider)).status).toBe(403);
    expect((await call('GET', `/applications/${applicationId}/credit-check`, { sub: 'sub-landlord-two', groups: 'landlord' })).status).toBeGreaterThanOrEqual(403);
  });

  it('can be agreed on the application form, and goes with the person on erasure', async () => {
    const made = await call('POST', '/auth/register', NOBODY, {
      name: 'Form Applicant', email: 'credit-form@example.co.za', password: 'a-long-password', consentVersion: PRIVACY_VERSION,
    });
    const person: As = { sub: made.body.user.sub, groups: 'tenant' };
    await db.query(`update unit set status = 'vacant' where id = $1`, [UNIT_B1]);
    const applied = await call('POST', '/applications', person, {
      unitId: UNIT_B1, firstName: 'Form', lastName: 'Applicant', idNumber: '9001015009086',
      email: 'credit-form@example.co.za', phone: '0825550124', employmentStatus: 'employed',
      monthlyIncomeCents: 4500000, occupants: 1, preferredMoveIn: '2099-01-01', consentVersion: PRIVACY_VERSION,
      creditCheckConsent: true,
    });
    expect(applied.status).toBe(201);
    expect((await call('GET', `/applications/${applied.body.id}/credit-check`, OWNER)).body.consent).not.toBeNull();

    const { erasePerson } = await import('../lib/privacy');
    await erasePerson(applicant.sub, { sub: 'test', role: 'landlord' }, { landlordId: '11111111-1111-1111-1111-111111111111' });
    const left = await db.query('select id from credit_check where application_id = $1', [applicationId]);
    expect(left).toHaveLength(0);
  });
});
