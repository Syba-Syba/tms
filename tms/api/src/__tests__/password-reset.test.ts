import { beforeAll, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

/** Forgotten passwords: the emailed link, its expiry, single use, and no account enumeration. */
let call: (path: string, body: unknown, ip?: string) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');

/** The link only exists in the outbox body, which is exactly where a tenant would find it. */
const linkFor = async (email: string) => {
  const [row] = await db.query<{ body: string }>(
    `select body from notification where recipient_to = $1 and kind = 'password_reset'
      order by created_at desc limit 1`,
    [email],
  );
  return row?.body.match(/token=([A-Za-z0-9_-]+)/)?.[1];
};

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://password-reset-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.AUTH_DRIVER = 'local';

  db = await import('../lib/db');
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  for (const file of all.filter((n) => !n.includes('seed'))) await db.execScript(read(file));
  for (const file of all.filter((n) => n.includes('seed'))) await db.execScript(read(file));

  const { handler } = await import('../api');
  call = async (path, body, ip = '10.9.0.1') => {
    const event = {
      rawPath: path,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      requestContext: {
        http: { method: 'POST', path, sourceIp: ip, userAgent: 'test' },
        authorizer: { jwt: { claims: { sub: 'anonymous', 'cognito:groups': '[tenant]' } } },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
    const result = (await handler(event)) as { statusCode: number; body?: string };
    return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : null };
  };
  await call('/auth/register', { name: 'Reset Person', email: 'reset@example.co.za', password: 'old-password-1' }, '10.9.9.1');
}, 120_000);

describe('password reset', () => {
  it('answers the same for an email with no account, and queues nothing', async () => {
    const known = await call('/auth/reset/request', { email: 'reset@example.co.za' }, '10.9.1.1');
    const unknown = await call('/auth/reset/request', { email: 'nobody@example.co.za' }, '10.9.1.2');
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(unknown.body).toEqual(known.body);
    expect(await linkFor('nobody@example.co.za')).toBeUndefined();
  });

  it('stores only a hash of the token', async () => {
    const token = await linkFor('reset@example.co.za');
    expect(token).toBeTruthy();
    const stored = await db.query('select 1 from password_reset where token_hash = $1', [token]);
    expect(stored).toHaveLength(0);
  });

  it('sets the new password once, signs in, and retires the link', async () => {
    await call('/auth/reset/request', { email: 'reset@example.co.za' }, '10.9.2.1');
    const token = await linkFor('reset@example.co.za');

    const done = await call('/auth/reset/confirm', { token, newPassword: 'brand-new-pass' }, '10.9.2.2');
    expect(done.status).toBe(200);
    expect(done.body.token).toBeTruthy();
    expect(done.body.user.email).toBe('reset@example.co.za');

    const again = await call('/auth/reset/confirm', { token, newPassword: 'another-pass-1' }, '10.9.2.3');
    expect(again.status).toBe(400);

    const oldLogin = await call('/auth/login', { email: 'reset@example.co.za', password: 'old-password-1' }, '10.9.2.4');
    const newLogin = await call('/auth/login', { email: 'reset@example.co.za', password: 'brand-new-pass' }, '10.9.2.5');
    expect(oldLogin.status).toBe(401);
    expect(newLogin.status).toBe(200);

    expect(await linkFor('reset@example.co.za')).toBeUndefined();
  });

  it('retires the earlier link when a new one is asked for', async () => {
    const email = 'twice@example.co.za';
    await call('/auth/register', { name: 'Twice Asked', email, password: 'twice-pass-1' }, '10.9.9.3');
    await call('/auth/reset/request', { email }, '10.9.3.1');
    const first = await linkFor(email);
    await call('/auth/reset/request', { email }, '10.9.3.2');
    const second = await linkFor(email);
    expect(second).not.toBe(first);

    expect((await call('/auth/reset/confirm', { token: first, newPassword: 'pass-from-first' }, '10.9.3.3')).status).toBe(400);
    expect((await call('/auth/reset/confirm', { token: second, newPassword: 'pass-from-second' }, '10.9.3.4')).status).toBe(200);
  });

  it('refuses an expired link', async () => {
    const email = 'late@example.co.za';
    await call('/auth/register', { name: 'Late Opener', email, password: 'late-pass-1' }, '10.9.9.4');
    await call('/auth/reset/request', { email }, '10.9.4.1');
    const token = await linkFor(email);
    await db.query(`update password_reset set expires_at = now() - interval '1 minute' where used_at is null`);
    const late = await call('/auth/reset/confirm', { token, newPassword: 'too-late-pass' }, '10.9.4.2');
    expect(late.status).toBe(400);
    expect(late.body.error.code).toBe('invalid_token');
  });

  it('sends at most three emails an hour to one account, and still answers 202', async () => {
    const email = 'flood@example.co.za';
    await call('/auth/register', { name: 'Flood Target', email, password: 'flood-pass-1' }, '10.9.9.2');
    for (let i = 0; i < 5; i += 1) {
      expect((await call('/auth/reset/request', { email }, `10.9.5.${i}`)).status).toBe(202);
    }
    const sent = await db.query(
      `select 1 from notification where recipient_to = $1 and kind = 'password_reset'`,
      [email],
    );
    expect(sent).toHaveLength(3);
  });
});
