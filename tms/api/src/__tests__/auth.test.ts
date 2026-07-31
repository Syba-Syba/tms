import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

/** The local auth driver end to end: seeded sign-in, self-registration, and the token that
    comes back verifying and expiring the way the dev server expects. */
let call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
let tokens: typeof import('../lib/authtoken');

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://auth-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.AUTH_DRIVER = 'local';

  const db = await import('../lib/db');
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  for (const file of all.filter((n) => !n.includes('seed'))) await db.execScript(read(file));
  for (const file of all.filter((n) => n.includes('seed'))) await db.execScript(read(file));

  tokens = await import('../lib/authtoken');
  const { handler } = await import('../api');
  call = async (method, path, body) => {
    const event = {
      rawPath: path,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      requestContext: {
        http: { method, path, sourceIp: '127.0.0.1', userAgent: 'test' },
        authorizer: { jwt: { claims: { sub: 'anonymous', 'cognito:groups': '[tenant]' } } },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
    const result = (await handler(event)) as { statusCode: number; body?: string };
    return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : null };
  };
}, 120_000);

afterAll(() => {
  delete process.env.AUTH_DRIVER;
});

describe('signing in', () => {
  it('signs the seeded landlord in and the token verifies', async () => {
    const response = await call('POST', '/auth/login', {
      email: 'landlord@example.co.za',
      password: 'dev',
    });
    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({ sub: 'sub-landlord', role: 'landlord' });

    const verified = tokens.verifyToken(response.body.token);
    expect(verified).toMatchObject({ sub: 'sub-landlord', role: 'landlord' });
  });

  it('answers a wrong password and an unknown email identically', async () => {
    const wrongPassword = await call('POST', '/auth/login', {
      email: 'landlord@example.co.za',
      password: 'nope',
    });
    const unknownEmail = await call('POST', '/auth/login', {
      email: 'nobody@example.co.za',
      password: 'nope',
    });
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body.error.message).toBe(unknownEmail.body.error.message);
  });

  it('rejects a tampered and an expired token', () => {
    const good = tokens.signToken({
      sub: 'sub-x',
      role: 'tenant',
      name: 'X',
      email: 'x@example.co.za',
    });
    expect(tokens.verifyToken(`${good.slice(0, -2)}zz`)).toBeNull();
    const expired = tokens.signToken(
      { sub: 'sub-x', role: 'tenant', name: 'X', email: 'x@example.co.za' },
      -1,
    );
    expect(tokens.verifyToken(expired)).toBeNull();
  });
});

describe('registering', () => {
  it('creates a tenant account, signs them in, and refuses the email twice', async () => {
    const created = await call('POST', '/auth/register', {
      name: 'Lerato Dube',
      email: 'lerato.new@example.co.za',
      password: 'a-long-password',
    });
    expect(created.status).toBe(201);
    expect(created.body.user.role).toBe('tenant');
    expect(created.body.user.sub.startsWith('local-')).toBe(true);

    const again = await call('POST', '/auth/register', {
      name: 'Lerato Again',
      email: 'lerato.new@example.co.za',
      password: 'another-password',
    });
    expect(again.status).toBe(409);

    const login = await call('POST', '/auth/login', {
      email: 'lerato.new@example.co.za',
      password: 'a-long-password',
    });
    expect(login.status).toBe(200);
    expect(login.body.user.sub).toBe(created.body.user.sub);
  });

  it('refuses a short password with the reason', async () => {
    const response = await call('POST', '/auth/register', {
      name: 'Short',
      email: 'short@example.co.za',
      password: 'short',
    });
    expect(response.status).toBe(400);
  });
});

describe('the driver guard', () => {
  it('is a 404 outside the local driver, exactly like a route that does not exist', async () => {
    delete process.env.AUTH_DRIVER;
    const response = await call('POST', '/auth/login', {
      email: 'landlord@example.co.za',
      password: 'dev',
    });
    expect(response.status).toBe(404);
    process.env.AUTH_DRIVER = 'local';
  });
});
