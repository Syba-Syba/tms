import { beforeAll, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const LEASE = '66666666-6666-6666-6666-666666666666';
const ELSEWHERE = '99999999-9999-4999-8999-999999999999';

/** GET /audit: a landlord reads back what happened on their own properties and account,
    and nothing about anyone else's. */
type Opts = { sub?: string; groups?: string; query?: Record<string, string> };
let call: (path: string, opts?: Opts) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://audit-log-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'tms-storage-'));
  process.env.KMS_DRIVER = 'local';

  db = await import('../lib/db');
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  for (const file of all.filter((n) => !n.includes('seed'))) await db.execScript(read(file));
  for (const file of all.filter((n) => n.includes('seed'))) await db.execScript(read(file));

  const { handler } = await import('../api');
  call = async (path, opts = {}) => {
    const event = {
      rawPath: path,
      headers: {},
      queryStringParameters: opts.query ?? {},
      pathParameters: {},
      requestContext: {
        http: { method: 'GET', path, sourceIp: '127.0.0.1', userAgent: 'test' },
        authorizer: {
          jwt: { claims: { sub: opts.sub ?? 'sub-landlord', 'cognito:groups': `[${opts.groups ?? 'landlord'}]` } },
        },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
    const result = (await handler(event)) as { statusCode: number; body?: string };
    return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : null };
  };

  await db.query('delete from audit_log');
  const add = (sub: string, role: string, action: string, entity: string, id: string | null) =>
    db.query(
      `insert into audit_log (actor_sub, actor_role, action, entity, entity_id, detail) values ($1, $2, $3, $4, $5, '{}')`,
      [sub, role, action, entity, id],
    );
  await add('sub-landlord', 'landlord', 'auth.login', 'credential', null);
  await add('sub-tenant', 'tenant', 'auth.login', 'credential', null);
  await add('sub-tenant', 'tenant', 'file.viewed', 'lease', LEASE);
  await add('sub-other-landlord', 'landlord', 'lease.signed', 'lease', ELSEWHERE);
  await add('system', 'job', 'job.finished', 'job', null);
  await add('sub-landlord', 'landlord', 'property.deleted', 'property', ELSEWHERE);
}, 120_000);

describe('the audit log', () => {
  it('shows a landlord their own leases and account, and nothing else', async () => {
    const res = await call('/audit');
    expect(res.status).toBe(200);
    const seen = res.body.items.map((row: any) => `${row.action}:${row.entity}`);
    expect(seen).toEqual(['property.deleted:property', 'file.viewed:lease', 'auth.login:credential']);
    // The tenant opening a file on the landlord's lease is shown with their name.
    const viewed = res.body.items.find((row: any) => row.action === 'file.viewed');
    expect(viewed.leaseId).toBe(LEASE);
    expect(viewed.actor.name).not.toBe('Unknown');
    expect(res.body.items.find((row: any) => row.action === 'auth.login').actor.name).toBe('You');
  });

  it('pages newest first with a cursor', async () => {
    const first = await call('/audit', { query: { limit: '2' } });
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextBefore).toBe(first.body.items[1].id);
    const second = await call('/audit', { query: { limit: '2', before: String(first.body.nextBefore) } });
    expect(second.body.items.map((row: any) => row.action)).toEqual(['auth.login']);
    expect(second.body.nextBefore).toBeNull();
  });

  it('filters to one record', async () => {
    const res = await call('/audit', { query: { entity: 'lease', entityId: LEASE } });
    expect(res.body.items.map((row: any) => row.action)).toEqual(['file.viewed']);
  });

  it('is refused to tenants and to bad filters', async () => {
    expect((await call('/audit', { sub: 'sub-tenant', groups: 'tenant' })).status).toBe(403);
    expect((await call('/audit', { query: { entity: "lease'; drop table lease; --" } })).status).toBe(400);
    expect((await call('/audit', { query: { limit: '500' } })).status).toBe(400);
  });
});
