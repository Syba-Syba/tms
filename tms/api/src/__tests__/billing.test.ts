import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { standing, planFor } from '../domain/plans';
import { addMonth } from '../lib/subscription';
import { checkoutFields, itnParamString, itnSignatureValid, parseItn, signFields } from '../lib/payfast';
import { addDaysIso, sastToday } from '../domain/dates';
import { PRIVACY_VERSION } from '../domain/privacy';
import { TERMS_VERSION } from '../domain/company';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const today = sastToday();

describe('plans and standing', () => {
  it('picks the smallest plan that fits', () => {
    expect(planFor(3)?.id).toBe('starter');
    expect(planFor(6)?.id).toBe('standard');
    expect(planFor(61)).toBeNull();
  });

  it('keeps paid time, gives a week of grace, then goes read-only', () => {
    const base = { trialEndsOn: '2026-10-01', currentPeriodEnd: '2026-10-20' };
    expect(standing({ ...base, status: 'trialing' }, '2026-10-01')).toBe('trial');
    expect(standing({ ...base, status: 'trialing' }, '2026-10-02')).toBe('lapsed');
    expect(standing({ ...base, status: 'active' }, '2026-10-27')).toBe('active');
    expect(standing({ ...base, status: 'active' }, '2026-10-28')).toBe('lapsed');
    expect(standing({ ...base, status: 'past_due' }, '2026-10-25')).toBe('past_due');
    expect(standing({ ...base, status: 'cancelled' }, '2026-10-20')).toBe('cancelling');
    expect(standing({ ...base, status: 'cancelled' }, '2026-10-21')).toBe('lapsed');
  });

  it('adds a month without running past the end of a short one', () => {
    expect(addMonth('2026-01-31')).toBe('2026-02-28');
    expect(addMonth('2026-10-28')).toBe('2026-11-28');
    expect(addMonth('2026-12-15')).toBe('2027-01-15');
  });
});

describe('PayFast signing', () => {
  const config = { merchantId: '10000100', merchantKey: '46f0cd694581a', passphrase: 'jt7NOE43FZPn', sandbox: true };
  const fields = checkoutFields(config, {
    checkoutId: 'c1', landlordId: 'l1', amountCents: 19_900, itemName: 'Threshold Starter, monthly', firstName: 'Sipho',
    email: 'sipho@example.co.za', returnUrl: 'https://app.example/r', cancelUrl: 'https://app.example/c',
    notifyUrl: 'https://api.example/billing/notify', billingDate: '2026-11-27',
  });

  it('signs the checkout over its fields in order, with the passphrase', () => {
    const signature = fields.find(([key]) => key === 'signature')![1];
    expect(signature).toMatch(/^[0-9a-f]{32}$/);
    expect(signFields(fields.filter(([key]) => key !== 'signature'), config.passphrase)).toBe(signature);
    expect(Object.fromEntries(fields)).toMatchObject({ amount: '199.00', recurring_amount: '199.00', frequency: '3', subscription_type: '1' });
    // Spaces are sent as '+', as PayFast encodes them.
    expect(itnParamString([['item_name', 'Threshold Starter, monthly']])).toBe('item_name=Threshold+Starter%2C+monthly');
  });

  it('checks a notification against the order it arrived in, and catches a changed amount', () => {
    const sent: [string, string][] = [
      ['m_payment_id', 'c1'], ['pf_payment_id', '1089250'], ['payment_status', 'COMPLETE'], ['item_name', 'Threshold Starter'],
      ['amount_gross', '199.00'], ['token', 'dc0521d3-55fe-269b-fa00-b647310d760f'],
    ];
    const signed: [string, string][] = [...sent, ['signature', signFields(sent, config.passphrase)]];
    const body = signed
      .map(([key, value]) => `${key}=${encodeURIComponent(value).replace(/%20/g, '+')}`)
      .join('&');
    expect(itnSignatureValid(parseItn(body), config.passphrase)).toBe(true);
    expect(itnSignatureValid(parseItn(body.replace('199.00', '1.00')), config.passphrase)).toBe(false);
    expect(itnSignatureValid(parseItn(body), 'another-passphrase')).toBe(false);
  });
});

type As = { sub: string; groups: string };
const OWNER: As = { sub: 'sub-landlord', groups: 'landlord' };
const TENANT: As = { sub: 'sub-tenant', groups: 'tenant' };
const LEASE = '66666666-6666-6666-6666-666666666666';
const PROPERTY = '22222222-2222-2222-2222-222222222222';
let call: (method: string, path: string, as: As, body?: unknown, raw?: string) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let unitNo = 0;
const addUnit = (as: As = OWNER) =>
  call('POST', `/properties/${PROPERTY}/units`, as, {
    code: `Z${(unitNo += 1)}`, bedrooms: 1, bathrooms: 1, monthlyRentCents: 500000, depositCents: 500000,
  });

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://billing-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.AUTH_DRIVER = 'local';
  delete process.env.BILLING_DRIVER;

  db = await import('../lib/db');
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  for (const file of all.filter((n) => !n.includes('seed'))) await db.execScript(read(file));
  for (const file of all.filter((n) => n.includes('seed'))) await db.execScript(read(file));

  const { handler } = await import('../api');
  let ip = 0;
  call = async (method, path, as, body, raw) => {
    const event = {
      rawPath: path,
      headers: { 'content-type': raw ? 'application/x-www-form-urlencoded' : 'application/json' },
      queryStringParameters: {},
      pathParameters: {},
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
      requestContext: {
        http: { method, path, sourceIp: `10.50.0.${(ip++ % 250) + 1}`, userAgent: 'test' },
        authorizer: { jwt: { claims: { sub: as.sub, 'cognito:groups': `[${as.groups}]` } } },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
    const result = (await handler(event)) as { statusCode: number; body?: string };
    let parsed: any = null;
    try { parsed = result.body ? JSON.parse(result.body) : null; } catch { parsed = result.body; }
    return { status: result.statusCode, body: parsed };
  };
}, 120_000);

afterEach(() => {
  delete process.env.BILLING_DRIVER;
});

describe('a landlord account over its life', () => {
  it('starts on a 30-day trial with room for the largest plan', async () => {
    const billing = await call('GET', '/billing', OWNER);
    expect(billing.body).toMatchObject({ driver: 'local', standing: 'trial', trialEndsOn: addDaysIso(today, 30), allowance: 60, units: 3, recommended: 'starter', isOwner: true });
  });

  it('goes read-only when the trial runs out, but tenants carry on', async () => {
    await db.query(`update subscription set trial_ends_on = $1 where landlord_id = '11111111-1111-1111-1111-111111111111'`, [addDaysIso(today, -1)]);
    expect((await call('GET', '/billing', OWNER)).body.standing).toBe('lapsed');
    const blocked = await addUnit();
    expect(blocked.status).toBe(402);
    expect(blocked.body.error.code).toBe('subscription_required');
    expect((await call('GET', '/properties', OWNER)).status).toBe(200);
    expect((await call('PUT', '/landlord', OWNER, { phone: '0821234567' })).status).toBe(200);
    const ticket = await call('POST', `/leases/${LEASE}/tickets`, TENANT, {
      title: 'Geyser leaking', description: 'Water through the ceiling', category: 'plumbing', severity: 'urgent',
    });
    expect(ticket.status).toBe(201);
  });

  it('pays for a plan through a checkout, and the account opens again', async () => {
    expect((await call('POST', '/billing/checkout', { sub: 'sub-tenant', groups: 'tenant' }, { plan: 'starter' })).status).toBe(403);
    const checkout = await call('POST', '/billing/checkout', OWNER, { plan: 'starter' });
    expect(checkout.body.kind).toBe('simulate');
    const paid = await call('POST', '/billing/simulate', OWNER, { checkoutId: checkout.body.checkoutId, outcome: 'paid' });
    expect(paid.body).toEqual({ applied: true });
    const billing = await call('GET', '/billing', OWNER);
    expect(billing.body).toMatchObject({ standing: 'active', plan: 'starter', paidUntil: addMonth(today), allowance: 5, hasRecurring: true });
    expect((await addUnit()).status).toBe(201);
  });

  it('holds the account to its plan\'s units', async () => {
    expect((await addUnit()).status).toBe(201);
    const over = await addUnit();
    expect(over.status).toBe(402);
    expect(over.body.error).toMatchObject({ code: 'plan_limit', message: 'Your plan covers 5 units and you have 5. Move to Standard to add more.' });
  });

  it('changes plan on the running payment, and refuses a plan too small', async () => {
    expect((await call('POST', '/billing/plan', OWNER, { action: 'change', plan: 'standard' })).body).toEqual({ plan: 'standard' });
    expect((await addUnit()).status).toBe(201);
    const down = await call('POST', '/billing/plan', OWNER, { action: 'change', plan: 'starter' });
    expect(down.status).toBe(400);
  });

  it('renews a month at a time, marks a failed payment, and keeps paid time after cancelling', async () => {
    await call('POST', '/billing/simulate', OWNER, { outcome: 'paid' });
    expect((await call('GET', '/billing', OWNER)).body.paidUntil).toBe(addMonth(addMonth(today)));
    await call('POST', '/billing/simulate', OWNER, { outcome: 'failed' });
    expect((await call('GET', '/billing', OWNER)).body.standing).toBe('past_due');
    expect((await addUnit()).status).toBe(201);
    expect((await call('POST', '/billing/plan', OWNER, { action: 'cancel' })).body.status).toBe('cancelled');
    expect((await call('GET', '/billing', OWNER)).body.standing).toBe('cancelling');
  });

  it('ignores a repeated notice and one for the wrong amount', async () => {
    const { applyPaymentNotice } = await import('../lib/billing-events');
    const [sub] = await db.query<{ provider_token: string }>(`select provider_token from subscription where landlord_id = '11111111-1111-1111-1111-111111111111'`);
    const notice = { provider: 'local', externalId: 'pf-1', checkoutId: null, token: sub!.provider_token, outcome: 'paid' as const, amountCents: 44_900, payload: {} };
    expect(await applyPaymentNotice(notice)).toEqual({ applied: true });
    expect(await applyPaymentNotice(notice)).toEqual({ applied: false, problem: 'duplicate' });
    expect(await applyPaymentNotice({ ...notice, externalId: 'pf-2', amountCents: 100 })).toEqual({ applied: false, problem: 'amount' });
    const rejected = await db.query(`select problem from billing_event where verified = false`);
    expect(rejected).toHaveLength(1);
  });
});

describe('paying during the trial', () => {
  it('keeps the trial and starts the paid month when it ends', async () => {
    const signed = await call('POST', '/auth/register', { sub: 'anonymous', groups: 'tenant' }, {
      name: 'Early Payer', email: 'early@example.co.za', password: 'a-long-password', consentVersion: PRIVACY_VERSION,
      termsVersion: TERMS_VERSION, landlord: { tradingName: 'Early Rentals', phone: '0825550202' },
    });
    const owner = { sub: signed.body.user.sub, groups: 'landlord' };
    const checkout = await call('POST', '/billing/checkout', owner, { plan: 'starter' });
    await call('POST', '/billing/simulate', owner, { checkoutId: checkout.body.checkoutId, outcome: 'paid' });
    expect((await call('GET', '/billing', owner)).body.paidUntil).toBe(addMonth(addDaysIso(today, 30)));
  });
});

describe('with PayFast', () => {
  it('hands back a signed form for the sandbox, and answers notifications only in that mode', async () => {
    expect((await call('POST', '/billing/notify', { sub: 'anonymous', groups: 'tenant' }, undefined, 'a=b')).status).toBe(404);
    process.env.BILLING_DRIVER = 'payfast';
    process.env.PAYFAST_MERCHANT_ID = '10000100';
    process.env.PAYFAST_MERCHANT_KEY = '46f0cd694581a';
    process.env.PAYFAST_PASSPHRASE = 'jt7NOE43FZPn';
    process.env.PAYFAST_SANDBOX = 'true';
    const signed = await call('POST', '/auth/register', { sub: 'anonymous', groups: 'tenant' }, {
      name: 'Card Payer', email: 'card@example.co.za', password: 'a-long-password', consentVersion: PRIVACY_VERSION,
      termsVersion: TERMS_VERSION, landlord: { tradingName: 'Card Rentals', phone: '0825550303' },
    });
    const checkout = await call('POST', '/billing/checkout', { sub: signed.body.user.sub, groups: 'landlord' }, { plan: 'pro' });
    expect(checkout.body.action).toBe('https://sandbox.payfast.co.za/eng/process');
    expect(checkout.body.fields).toMatchObject({ merchant_id: '10000100', amount: '999.00', notify_url: 'http://localhost:5173/billing/notify' });
    const fields = Object.entries(checkout.body.fields as Record<string, string>);
    expect(signFields(fields.filter(([key]) => key !== 'signature'), 'jt7NOE43FZPn')).toBe(checkout.body.fields.signature);

    // A forged notification is answered, kept, and changes nothing.
    const forged = await call('POST', '/billing/notify', { sub: 'anonymous', groups: 'tenant' }, undefined,
      `m_payment_id=x&payment_status=COMPLETE&amount_gross=999.00&signature=${'0'.repeat(32)}`);
    expect(forged.status).toBe(200);
    const [kept] = await db.query<{ problem: string }>(`select problem from billing_event where provider = 'payfast'`);
    expect(kept!.problem).toBe('Signature does not match.');
  });
});
