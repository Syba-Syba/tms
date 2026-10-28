import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TERMS_VERSION, vatIn } from '../domain/company';
import { PRIVACY_VERSION } from '../domain/privacy';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

describe('VAT in a price', () => {
  it('is 15/115 of a VAT-inclusive amount, and nothing when not registered', () => {
    expect(vatIn(19_900, true)).toBe(2_596);
    expect(vatIn(44_900, true)).toBe(5_857);
    expect(vatIn(19_900, false)).toBe(0);
  });
});

type As = { sub: string; groups: string };
const NOBODY: As = { sub: 'anonymous', groups: 'tenant' };
let call: (method: string, path: string, as: As, body?: unknown) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let storage: typeof import('../lib/storage');
let owner: As;

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://terms-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.AUTH_DRIVER = 'local';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'tms-terms-'));
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
    const event = {
      rawPath: path,
      headers: { 'content-type': 'application/json' },
      queryStringParameters: {},
      pathParameters: {},
      body: body === undefined ? undefined : JSON.stringify(body),
      requestContext: {
        http: { method, path, sourceIp: `10.70.0.${(ip++ % 250) + 1}`, userAgent: 'test' },
        authorizer: { jwt: { claims: { sub: as.sub, 'cognito:groups': `[${as.groups}]` } } },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
    const result = (await handler(event)) as { statusCode: number; body?: string };
    return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : null };
  };
}, 120_000);

afterEach(() => {
  for (const key of ['COMPANY_NAME', 'COMPANY_LEGAL_NAME', 'COMPANY_VAT_NO', 'COMPANY_REG_NO']) delete process.env[key];
});

const signUp = (email: string, extra: Record<string, unknown> = {}) =>
  call('POST', '/auth/register', NOBODY, {
    name: 'Terms Owner', email, password: 'a-long-password', consentVersion: PRIVACY_VERSION,
    landlord: { tradingName: 'Terms Rentals', phone: '0825551010' }, ...extra,
  });

describe('terms of service', () => {
  it('must be agreed to open a landlord account, and the agreement is kept', async () => {
    expect((await signUp('no-terms@example.co.za')).status).toBe(400);
    expect((await signUp('old-terms@example.co.za', { termsVersion: '2020-01-01' })).status).toBe(400);
    const signed = await signUp('terms@example.co.za', { termsVersion: TERMS_VERSION });
    expect(signed.status).toBe(201);
    owner = { sub: signed.body.user.sub, groups: 'landlord' };
    const [consent] = await db.query<{ version: string; ip_address: string }>(
      `select version, ip_address from consent where person_sub = $1 and kind = 'terms_of_service'`,
      [owner.sub],
    );
    expect(consent).toMatchObject({ version: TERMS_VERSION });
    expect((await call('GET', '/me/privacy', owner)).body.terms).toEqual({ currentVersion: TERMS_VERSION, acceptedVersion: TERMS_VERSION });
  });

  it('are asked of landlords who have not agreed, and never of tenants', async () => {
    const seeded = await call('GET', '/me/privacy', { sub: 'sub-landlord', groups: 'landlord' });
    expect(seeded.body.terms).toEqual({ currentVersion: TERMS_VERSION, acceptedVersion: null });
    expect((await call('POST', '/me/consents', { sub: 'sub-landlord', groups: 'landlord' }, { kind: 'terms_of_service', version: '2001-01-01' })).status).toBe(400);
    expect((await call('POST', '/me/consents', { sub: 'sub-landlord', groups: 'landlord' }, { kind: 'terms_of_service', version: TERMS_VERSION })).status).toBe(201);
    expect((await call('GET', '/me/privacy', { sub: 'sub-tenant', groups: 'tenant' })).body.terms).toBeNull();
  });

  it('name the operator, from settings, without a sign-in', async () => {
    process.env.COMPANY_NAME = 'Threshold';
    process.env.COMPANY_LEGAL_NAME = 'Threshold Software (Pty) Ltd';
    process.env.COMPANY_REG_NO = '2026/123456/07';
    const details = await call('GET', '/company', NOBODY);
    expect(details.body).toMatchObject({ name: 'Threshold', legalName: 'Threshold Software (Pty) Ltd', registrationNo: '2026/123456/07', termsVersion: TERMS_VERSION });
  });
});

describe('invoices for the subscription', () => {
  it('are issued for each payment, with the VAT shown when the operator is registered', async () => {
    process.env.COMPANY_VAT_NO = '4123456789';
    process.env.COMPANY_LEGAL_NAME = 'Threshold Software (Pty) Ltd';
    expect((await call('PUT', '/landlord', owner, { vatNo: '123' })).status).toBe(400);
    expect((await call('PUT', '/landlord', owner, { vatNo: '4987654321' })).status).toBe(200);
    const checkout = await call('POST', '/billing/checkout', owner, { plan: 'starter' });
    await call('POST', '/billing/simulate', owner, { checkoutId: checkout.body.checkoutId, outcome: 'paid' });

    const list = await call('GET', '/billing/invoices', owner);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ number: '1001', plan: 'starter', amountCents: 19_900, vatCents: 2_596 });
    const [row] = await db.query<{ supplier: any; recipient: any }>('select supplier, recipient from billing_invoice');
    expect(row!.supplier).toMatchObject({ legalName: 'Threshold Software (Pty) Ltd', vatNo: '4123456789' });
    expect(row!.recipient).toMatchObject({ name: 'Terms Rentals', vatNo: '4987654321' });
    const [mail] = await db.query<{ subject: string }>(`select subject from notification where kind = 'billing_invoice'`);
    expect(mail!.subject).toMatch(/^Tax invoice 1001 from Threshold: R/);
  });

  it('open as a PDF for the landlord\'s team only, and the same file every time', async () => {
    const id = (await call('GET', '/billing/invoices', owner)).body.items[0].id;
    const first = await call('POST', `/billing/invoices/${id}/render`, owner);
    expect(first.body.key).toBe(`billing-invoices/${(await db.query<{ landlord_id: string }>('select landlord_id from billing_invoice'))[0]!.landlord_id}/1001.pdf`);
    const bytes = await storage.storage().get(first.body.key);
    expect(Buffer.from(bytes).subarray(0, 4).toString()).toBe('%PDF');
    expect((await call('POST', `/billing/invoices/${id}/render`, owner)).body.key).toBe(first.body.key);

    expect((await call('POST', '/files/view', owner, { key: first.body.key })).status).toBe(200);
    expect((await call('POST', '/files/view', { sub: 'sub-landlord', groups: 'landlord' }, { key: first.body.key })).status).toBe(404);
    expect((await call('POST', '/files/view', { sub: 'sub-tenant', groups: 'tenant' }, { key: first.body.key })).status).toBe(404);
    expect((await call('POST', `/billing/invoices/${id}/render`, { sub: 'sub-landlord', groups: 'landlord' })).status).toBe(404);
  });
});
