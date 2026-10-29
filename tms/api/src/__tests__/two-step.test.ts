import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { base32Decode, base32Encode, codeFor, matchingStep, openSecret, sealSecret, stepAt } from '../lib/totp';
import { PRIVACY_VERSION } from '../domain/privacy';
import { TERMS_VERSION } from '../domain/company';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

describe('one-time codes', () => {
  // RFC 6238 appendix B: the SHA1 secret is the ASCII "12345678901234567890".
  const rfc = base32Encode(Buffer.from('12345678901234567890'));

  it('match the RFC test vectors', () => {
    expect(rfc).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(codeFor(rfc, stepAt(59_000))).toBe('287082');
    expect(codeFor(rfc, stepAt(1_111_111_109_000))).toBe('081804');
    expect(base32Decode(rfc).toString()).toBe('12345678901234567890');
  });

  it('allow one step of clock drift either way, and never the same step twice', () => {
    const now = 1_700_000_000_000;
    const step = stepAt(now);
    expect(matchingStep(rfc, codeFor(rfc, step - 1), null, now)).toBe(step - 1);
    expect(matchingStep(rfc, codeFor(rfc, step + 1), null, now)).toBe(step + 1);
    expect(matchingStep(rfc, codeFor(rfc, step + 2), null, now)).toBeNull();
    expect(matchingStep(rfc, codeFor(rfc, step), step, now)).toBeNull();
    expect(matchingStep(rfc, '12345', null, now)).toBeNull();
  });

  it('keep the secret sealed at rest', () => {
    const sealed = sealSecret(rfc);
    expect(sealed.toString('latin1')).not.toContain(rfc);
    expect(openSecret(sealed)).toBe(rfc);
  });
});

type As = { sub: string; groups: string };
const OWNER: As = { sub: 'sub-landlord', groups: 'landlord' };
const NOBODY: As = { sub: 'anonymous', groups: 'tenant' };
let call: (method: string, path: string, as: As, body?: unknown) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let secret: string;
let clock = Date.now();
/** Each code is accepted once per 30 seconds, so the tests move the clock on between uses. */
const nextCode = () => {
  clock += 31_000;
  vi.setSystemTime(clock);
  return codeFor(secret, stepAt(clock));
};
const bank = (accountNumber: string) => ({ bank: { name: 'Capitec', holder: 'Mokoena Properties', accountNumber, branchCode: '470010' } });

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://two-step-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.AUTH_DRIVER = 'local';

  db = await import('../lib/db');
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  for (const file of all.filter((n) => !n.includes('seed'))) await db.execScript(read(file));
  for (const file of all.filter((n) => n.includes('seed'))) await db.execScript(read(file));

  const { handler } = await import('../api');
  let ip = 0;
  call = async (method, fullPath, as, body) => {
    const [path = fullPath, search] = fullPath.split('?');
    const event = {
      rawPath: path,
      headers: { 'content-type': 'application/json' },
      queryStringParameters: Object.fromEntries(new URLSearchParams(search ?? '')),
      pathParameters: {},
      body: body === undefined ? undefined : JSON.stringify(body),
      requestContext: {
        http: { method, path, sourceIp: `10.40.0.${(ip++ % 250) + 1}`, userAgent: 'test' },
        authorizer: { jwt: { claims: { sub: as.sub, 'cognito:groups': `[${as.groups}]` } } },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
    const result = (await handler(event)) as { statusCode: number; body?: string };
    return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : null };
  };
}, 120_000);

afterAll(() => vi.useRealTimers());

const login = (code?: string) =>
  call('POST', '/auth/login', NOBODY, { email: 'landlord@example.co.za', password: 'dev', ...(code ? { code } : {}) });

describe('turning two-step on', () => {
  let recovery: string[];

  it('needs a code from the scanned secret, and hands out ten recovery codes once', async () => {
    expect((await call('GET', '/auth/two-step', OWNER)).body).toEqual({ enabled: false, recoveryCodesLeft: 0 });
    // A session alone cannot turn it on: that path let a stolen session change the bank account.
    expect((await call('POST', '/auth/two-step', OWNER, { action: 'setup' })).status).toBe(400);
    const wrongPassword = await call('POST', '/auth/two-step', OWNER, { action: 'setup', password: 'not-it' });
    expect([wrongPassword.status, wrongPassword.body.error.code]).toEqual([403, 'password_wrong']);
    const setup = await call('POST', '/auth/two-step', OWNER, { action: 'setup', password: 'dev' });
    secret = setup.body.secret;
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\/Threshold%3Alandlord%40example\.co\.za\?secret=/);
    expect((await call('POST', '/auth/two-step', OWNER, { action: 'enable', password: 'dev', code: '000000' })).status).toBe(400);
    expect((await call('POST', '/auth/two-step', OWNER, { action: 'enable', code: nextCode() })).status).toBe(400);
    expect((await call('POST', '/auth/two-step', OWNER, { action: 'enable', password: 'not-it', code: nextCode() })).status).toBe(403);
    const on = await call('POST', '/auth/two-step', OWNER, { action: 'enable', password: 'dev', code: nextCode() });
    expect(on.status).toBe(200);
    recovery = on.body.recoveryCodes;
    expect(recovery).toHaveLength(10);
    expect(await db.query('select 1 from recovery_code where code_hash = $1', [recovery[0]])).toHaveLength(0);
  });

  it('asks for the code after the password, and refuses a reused or wrong one', async () => {
    expect((await login()).body.error.code).toBe('code_required');
    expect((await login('123456')).body.error.code).toBe('code_wrong');
    const code = nextCode();
    expect((await login(code)).status).toBe(200);
    expect((await login(code)).body.error.code).toBe('code_wrong');
  });

  it('takes a recovery code once', async () => {
    expect((await login(recovery[0])).status).toBe(200);
    expect((await login(recovery[0])).status).toBe(401);
    expect((await call('GET', '/auth/two-step', OWNER)).body.recoveryCodesLeft).toBe(9);
  });

  it('does not let a password reset link sign straight in', async () => {
    await call('POST', '/auth/reset/request', NOBODY, { email: 'landlord@example.co.za' });
    const [row] = await db.query<{ body: string }>(
      `select body from notification where kind = 'password_reset' order by created_at desc limit 1`,
    );
    const token = row!.body.match(/token=([A-Za-z0-9_-]+)/)![1];
    const reset = await call('POST', '/auth/reset/confirm', NOBODY, { token, newPassword: 'dev-but-longer' });
    expect(reset.body).toEqual({ token: null, user: null, signInWithCode: true });
    await db.query(`update local_credential set password_hash = 'plain:dev' where sub = 'sub-landlord'`);
  });
});

describe('changing the bank account', () => {
  it('needs a current code to replace the account on file', async () => {
    const without = await call('PUT', '/landlord', OWNER, bank('1234567890'));
    expect(without.body.error.code).toBe('code_required');
    const wrong = await call('PUT', '/landlord', OWNER, { ...bank('1234567890'), code: '000000' });
    // A 403, not a 401: the session is fine, and a 401 signed the person out in the app.
    expect([wrong.status, wrong.body.error.code]).toEqual([403, 'code_wrong']);
    expect(without.status).toBe(403);
    expect((await call('PUT', '/landlord', OWNER, { ...bank('1234567890'), code: nextCode() })).status).toBe(200);
    // Saving the same details again changes nothing, so it needs no code.
    expect((await call('PUT', '/landlord', OWNER, bank('1234567890'))).status).toBe(200);
  });

  it('tells every tenant and the owner at both addresses', async () => {
    const tenant = await db.query<{ subject: string }>(
      `select subject from notification where kind = 'landlord_bank_changed' and recipient_sub = 'sub-tenant' and channel = 'email'`,
    );
    expect(tenant).toEqual([{ subject: 'Mokoena Properties changed the account for your rent' }]);
    const owner = await db.query<{ recipient_to: string }>(
      `select recipient_to from notification where kind = 'bank_changed_alert' order by recipient_to`,
    );
    expect(owner.map((row) => row.recipient_to)).toEqual(['landlord@example.co.za', 'owner@example.co.za']);
    const log = await call('GET', '/audit?entity=landlord', OWNER);
    expect(log.body.items.find((item: any) => item.action === 'landlord.bank_changed')).toMatchObject({ detail: { from: '5678', to: '7890' } });
    const statement = await call('GET', '/leases/66666666-6666-6666-6666-666666666666/statement', { sub: 'sub-tenant', groups: 'tenant' });
    expect(statement.body).toMatchObject({ bank: { accountNumber: '1234567890' }, landlordPhone: '+27821234567' });
    expect(statement.body.bankChangedOn).toBeTruthy();
  });

  it('lets a new landlord add the first account freely, then asks for two-step before a change', async () => {
    const signed = await call('POST', '/auth/register', NOBODY, {
      name: 'New Owner', email: 'new.owner@example.co.za', password: 'a-long-password', consentVersion: PRIVACY_VERSION,
      termsVersion: TERMS_VERSION, landlord: { tradingName: 'New Owner Rentals', phone: '0825550101' },
    });
    const owner = { sub: signed.body.user.sub, groups: 'landlord' };
    expect((await call('PUT', '/landlord', owner, bank('1111111111'))).status).toBe(200);
    const change = await call('PUT', '/landlord', owner, bank('2222222222'));
    expect(change.status).toBe(403);
    expect(change.body.error.code).toBe('two_step_required');
  });
});

describe('guessing codes', () => {
  it('stops after five wrong codes on a bank change, so a stolen session cannot guess its way in', async () => {
    const { secondStepsByAccount } = await import('../lib/ratelimit');
    for (let i = 0; i < 5; i += 1) {
      expect((await call('PUT', '/landlord', OWNER, { ...bank('3333333333'), code: '000000' })).status).toBe(403);
    }
    const blocked = await call('PUT', '/landlord', OWNER, { ...bank('3333333333'), code: nextCode() });
    expect(blocked.status).toBe(429);
    secondStepsByAccount.clear('sub-landlord');
  });
});

describe('turning two-step off', () => {
  it('needs the password and a code', async () => {
    expect((await call('POST', '/auth/two-step', OWNER, { action: 'disable', password: 'wrong', code: nextCode() })).status).toBe(403);
    expect((await call('POST', '/auth/two-step', OWNER, { action: 'disable', password: 'dev', code: nextCode() })).body).toEqual({ enabled: false });
    expect((await login()).status).toBe(200);
  });
});
