import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

/**
 * Every read route, driven through the real router against a real Postgres.
 *
 * This exists because `GET /tickets` selected from a table it never joined and returned a 500
 * on every call, from the day it was written until someone opened it in a browser. Unit tests
 * on the domain could never have caught it: the SQL only breaks when Postgres parses it.
 */
let call: (method: string, path: string, opts?: { sub?: string; groups?: string; body?: unknown }) => Promise<{ status: number; body: any }>;

beforeAll(async () => {
  // The API opens its own connection from these, so migrations run through the same one.
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://routes-${Date.now()}`;
  process.env.NODE_ENV = 'development';

  const { execScript } = await import('../lib/db');
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();

  // Schema first, then the seed. The seed uses columns that later migrations add, so running
  // it in filename order fails on landlord.cognito_sub.
  for (const file of all.filter((n) => !n.includes('seed'))) await execScript(read(file));
  for (const file of all.filter((n) => n.includes('seed'))) await execScript(read(file));

  const { handler } = await import('../api');
  call = async (method, path, opts = {}) => {
    const [rawPath, rawQuery] = path.split('?');
    const event = {
      rawPath,
      headers: { 'content-type': 'application/json' },
      queryStringParameters: Object.fromEntries(new URLSearchParams(rawQuery ?? '')),
      pathParameters: {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      requestContext: {
        http: { method, path: rawPath, sourceIp: '127.0.0.1', userAgent: 'test' },
        authorizer: {
          jwt: {
            claims: {
              sub: opts.sub ?? 'sub-landlord',
              'cognito:groups': `[${opts.groups ?? 'landlord'}]`,
            },
          },
        },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
    const result = (await handler(event)) as { statusCode: number; body?: string };
    return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : null };
  };
}, 120_000);

describe('every read route answers', () => {
  const LEASE = '66666666-6666-6666-6666-666666666666';

  it('lists the portfolio for the landlord', async () => {
    const response = await call('GET', '/properties');
    expect(response.status).toBe(200);
    expect(response.body.items[0].units.length).toBeGreaterThan(0);
  });

  it('lists vacant units for an applicant', async () => {
    const response = await call('GET', '/units/available', { sub: 'sub-new', groups: 'tenant' });
    expect(response.status).toBe(200);
    expect(response.body.items.every((unit: any) => unit.monthlyRentCents > 0)).toBe(true);
  });

  it('answers the contractor directory even when it is empty', async () => {
    const response = await call('GET', '/contractors');
    expect(response.status).toBe(200);
    expect(response.body.items).toEqual([]);
  });

  it('lists leases for the landlord', async () => {
    const response = await call('GET', '/leases');
    expect(response.status).toBe(200);
    expect(response.body.role).toBe('landlord');
    expect(response.body.items[0].unit).toContain('Kruis Court');
    expect(response.body.items[0].depositBalanceCents).toBe(850000);
  });

  it('lists only their own lease for the tenant', async () => {
    const response = await call('GET', '/leases', { sub: 'sub-tenant', groups: 'tenant' });
    expect(response.status).toBe(200);
    expect(response.body.role).toBe('tenant');
    expect(response.body.items).toHaveLength(1);
  });

  it('shows a stranger nothing', async () => {
    const response = await call('GET', '/leases', { sub: 'sub-nobody', groups: 'tenant' });
    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(0);
  });

  it('lists applications', async () => {
    const response = await call('GET', '/applications');
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.items)).toBe(true);
  });

  it('lists tickets without a 500', async () => {
    // The regression this file was written for.
    const response = await call('GET', '/tickets');
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.items)).toBe(true);
  });

  it('lists closed tickets too', async () => {
    const response = await call('GET', '/tickets?status=closed');
    expect(response.status).toBe(200);
  });

  it('rejects an unknown status filter rather than interpolating it', async () => {
    const response = await call('GET', "/tickets?status=x') or true--");
    expect(response.status).toBe(400);
  });

  it('returns notification preferences', async () => {
    const response = await call('GET', '/notifications/preferences');
    expect(response.status).toBe(200);
    expect(response.body.preferences.length).toBeGreaterThan(0);
  });

  it('returns a lease statement to the landlord', async () => {
    const response = await call('GET', `/leases/${LEASE}/statement`);
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('depositBalanceCents');
  });

  it('returns the same statement to the tenant', async () => {
    const response = await call('GET', `/leases/${LEASE}/statement`, {
      sub: 'sub-tenant',
      groups: 'tenant',
    });
    expect(response.status).toBe(200);
  });

  it('refuses a stranger', async () => {
    const response = await call('GET', `/leases/${LEASE}/statement`, {
      sub: 'sub-nobody',
      groups: 'tenant',
    });
    expect(response.status).toBe(403);
  });

  it('returns one lease with everything hanging off it', async () => {
    const response = await call('GET', `/leases/${LEASE}`);
    expect(response.status).toBe(200);
    expect(response.body.ref).toMatch(/^LSE-\d{5}$/);
    expect(response.body.viewer.isLandlord).toBe(true);
    expect(Array.isArray(response.body.inspections)).toBe(true);
    expect(Array.isArray(response.body.invoices)).toBe(true);
    expect(response.body.termination).toBeNull();
  });

  it('returns a ticket with its timeline', async () => {
    const created = await call('POST', `/leases/${LEASE}/tickets`, {
      sub: 'sub-tenant',
      groups: 'tenant',
      body: {
        category: 'plumbing',
        severity: 'urgent',
        title: 'Tap dripping',
        description: 'Kitchen tap has dripped since Monday morning.',
      },
    });
    expect(created.status).toBe(201);

    const detail = await call('GET', `/tickets/${created.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.title).toBe('Tap dripping');
    expect(detail.body.events[0].kind).toBe('created');
    expect(detail.body.contractor).toBeNull();
  });

  it('walks a ticket through assignment, quote and completion', async () => {
    const list = await call('GET', '/tickets');
    const id = list.body.items[0].id;

    const assign = await call('POST', `/tickets/${id}/actions`, {
      body: {
        action: 'assign',
        contractor: { name: 'Sizwe Plumbing', trade: 'plumbing', phone: '0791234411' },
      },
    });
    expect(assign.status).toBe(200);

    const quote = await call('POST', `/tickets/${id}/actions`, {
      body: { action: 'quote', quoteCents: 785000 },
    });
    expect(quote.status).toBe(200);

    const approve = await call('POST', `/tickets/${id}/actions`, {
      body: { action: 'approve_quote' },
    });
    expect(approve.status).toBe(200);

    await call('POST', `/tickets/${id}/actions`, { body: { action: 'start' } });
    await call('POST', `/tickets/${id}/actions`, { body: { action: 'complete' } });

    const detail = await call('GET', `/tickets/${id}`);
    expect(detail.body.status).toBe('done');
    expect(detail.body.contractor.name).toBe('Sizwe Plumbing');
    expect(detail.body.quoteCents).toBe(785000);

    // Only the tenant closes, and only with a rating.
    const badClose = await call('POST', `/tickets/${id}/close`, { body: { rating: 4 } });
    expect(badClose.status).toBe(403);

    const closed = await call('POST', `/tickets/${id}/close`, {
      sub: 'sub-tenant',
      groups: 'tenant',
      body: { rating: 4, note: 'Fast and tidy.' },
    });
    expect(closed.status).toBe(200);
  });

  it('404s an unknown path instead of throwing', async () => {
    const response = await call('GET', '/nope');
    expect(response.status).toBe(404);
  });
});
