import { beforeAll, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

/** Sign-in limits, the password change, and the fingerprint that ends old sessions. */
type Caller = { sub: string; ip?: string };
let call: (method: string, path: string, body?: unknown, as?: Caller) => Promise<{ status: number; body: any }>;
let tokens: typeof import('../lib/authtoken');
let db: typeof import('../lib/db');

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://auth-hardening-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.AUTH_DRIVER = 'local';

  db = await import('../lib/db');
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  for (const file of all.filter((n) => !n.includes('seed'))) await db.execScript(read(file));
  for (const file of all.filter((n) => n.includes('seed'))) await db.execScript(read(file));

  tokens = await import('../lib/authtoken');
  const { handler } = await import('../api');
  call = async (method, path, body, as = { sub: 'anonymous' }) => {
    const event = {
      rawPath: path,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      requestContext: {
        http: { method, path, sourceIp: as.ip ?? '10.0.0.1', userAgent: 'test' },
        authorizer: { jwt: { claims: { sub: as.sub, 'cognito:groups': '[tenant]' } } },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
    const result = (await handler(event)) as { statusCode: number; body?: string };
    return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : null };
  };
}, 120_000);

const register = (email: string, password: string, ip: string) =>
  call('POST', '/auth/register', { name: 'Test Person', email, password }, { sub: 'anonymous', ip });

describe('sign-in limits', () => {
  it('locks an account after ten wrong passwords, even with the right one on the eleventh', async () => {
    const made = await register('locked@example.co.za', 'correct-horse-1', '10.1.0.1');
    expect(made.status).toBe(201);

    for (let i = 0; i < 10; i++) {
      const wrong = await call('POST', '/auth/login', { email: 'locked@example.co.za', password: 'nope' }, { sub: 'anonymous', ip: `10.2.0.${i}` });
      expect(wrong.status).toBe(401);
    }
    const right = await call('POST', '/auth/login', { email: 'locked@example.co.za', password: 'correct-horse-1' }, { sub: 'anonymous', ip: '10.2.1.1' });
    expect(right.status).toBe(429);
    expect(right.body.error.message).toMatch(/Try again in/);
  });

  it('limits one address walking many accounts', async () => {
    let last = 0;
    for (let i = 0; i < 31; i++) {
      last = (await call('POST', '/auth/login', { email: `nobody${i}@example.co.za`, password: 'x' }, { sub: 'anonymous', ip: '10.3.0.1' })).status;
    }
    expect(last).toBe(429);
  });

  it('does not count a successful sign-in against the account', async () => {
    await register('fine@example.co.za', 'correct-horse-2', '10.4.0.1');
    for (let i = 0; i < 9; i++) {
      await call('POST', '/auth/login', { email: 'fine@example.co.za', password: 'nope' }, { sub: 'anonymous', ip: '10.4.1.1' });
    }
    const ok = await call('POST', '/auth/login', { email: 'fine@example.co.za', password: 'correct-horse-2' }, { sub: 'anonymous', ip: '10.4.1.2' });
    expect(ok.status).toBe(200);
    // The success cleared the count, so a typo now is not the one that locks the account.
    const typo = await call('POST', '/auth/login', { email: 'fine@example.co.za', password: 'nope' }, { sub: 'anonymous', ip: '10.4.1.3' });
    expect(typo.status).toBe(401);
  });

  it('limits sign-ups from one address', async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await register(`many${i}@example.co.za`, 'long-enough-pw', '10.5.0.1')).status;
    expect(last).toBe(429);
  });
});

describe('changing a password', () => {
  it('needs the current password', async () => {
    const response = await call(
      'POST',
      '/auth/password',
      { currentPassword: 'wrong', newPassword: 'a-new-password' },
      { sub: 'sub-tenant' },
    );
    expect(response.status).toBe(400);
    expect(response.body.error.details.currentPassword).toMatch(/not your current password/);
  });

  it('changes it, signs in with the new one, and refuses the old one', async () => {
    const before = await call('POST', '/auth/login', { email: 'naledi@example.co.za', password: 'dev' }, { sub: 'anonymous', ip: '10.6.0.1' });
    expect(before.status).toBe(200);
    const oldVersion = tokens.verifyToken(before.body.token)?.pv;

    const changed = await call(
      'POST',
      '/auth/password',
      { currentPassword: 'dev', newPassword: 'naledi-new-password' },
      { sub: 'sub-tenant' },
    );
    expect(changed.status).toBe(200);

    // The fresh token carries the new fingerprint; the old token's no longer matches the store,
    // which is what the self-hosted server checks on every request.
    const newVersion = tokens.verifyToken(changed.body.token)?.pv;
    expect(newVersion).toBeTruthy();
    expect(newVersion).not.toBe(oldVersion);
    const [row] = await db.query<{ password_hash: string }>(
      'select password_hash from local_credential where sub = $1',
      ['sub-tenant'],
    );
    expect(tokens.credentialVersion(row!.password_hash)).toBe(newVersion);

    const oldPassword = await call('POST', '/auth/login', { email: 'naledi@example.co.za', password: 'dev' }, { sub: 'anonymous', ip: '10.6.0.2' });
    expect(oldPassword.status).toBe(401);
    const newPassword = await call('POST', '/auth/login', { email: 'naledi@example.co.za', password: 'naledi-new-password' }, { sub: 'anonymous', ip: '10.6.0.3' });
    expect(newPassword.status).toBe(200);
  });

  it('refuses a new password that is the same as the old one', async () => {
    await register('same@example.co.za', 'same-password-1', '10.7.0.1');
    const [cred] = await db.query<{ sub: string }>('select sub from local_credential where email = $1', ['same@example.co.za']);
    const response = await call(
      'POST',
      '/auth/password',
      { currentPassword: 'same-password-1', newPassword: 'same-password-1' },
      { sub: cred!.sub },
    );
    expect(response.status).toBe(400);
    expect(response.body.error.details.newPassword).toBeTruthy();
  });
});

describe('tokens', () => {
  it('carry a fingerprint from sign-in and from sign-up', async () => {
    const made = await register('print@example.co.za', 'fingerprint-pw', '10.8.0.1');
    expect(tokens.verifyToken(made.body.token)?.pv).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });
});
