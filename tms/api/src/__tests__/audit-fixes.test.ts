import { beforeAll, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const LEASE = '66666666-6666-6666-6666-666666666666';

/** Regressions for the bugs found in the October 2026 audit. Each case reproduced the bug
    before its fix. */
type Opts = { sub?: string; groups?: string; body?: unknown };
let call: (method: string, path: string, opts?: Opts) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let dates: typeof import('../domain/dates');

const tenant: Opts = { sub: 'sub-tenant', groups: 'tenant' };

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://audit-fixes-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'tms-storage-'));
  process.env.KMS_DRIVER = 'local';

  db = await import('../lib/db');
  dates = await import('../domain/dates');
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  for (const file of all.filter((n) => !n.includes('seed'))) await db.execScript(read(file));
  for (const file of all.filter((n) => n.includes('seed'))) await db.execScript(read(file));

  const { handler } = await import('../api');
  call = async (method, path, opts = {}) => {
    const event = {
      rawPath: path,
      headers: { 'content-type': 'application/json' },
      queryStringParameters: {},
      pathParameters: {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      requestContext: {
        http: { method, path, sourceIp: '127.0.0.1', userAgent: 'test' },
        authorizer: {
          jwt: { claims: { sub: opts.sub ?? 'sub-landlord', 'cognito:groups': `[${opts.groups ?? 'landlord'}]` } },
        },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
    const result = (await handler(event)) as { statusCode: number; body?: string };
    return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : null };
  };
}, 120_000);


describe('re-rating an imported lease when notice cuts a month short', () => {
  it('counts escalation from when it applies, not from the original start', async () => {
    // Renting since 2022, imported with its current R10 000 rent; escalation counts from 2026-03-01.
    await db.query(
      `update lease set start_date = '2022-03-01', end_date = '2027-02-28', escalates_from = '2026-03-01',
              monthly_rent_cents = 1000000, escalation_pct = 8 where id = $1`,
      [LEASE],
    );
    await db.query('delete from payment where lease_id = $1', [LEASE]);
    await db.query('delete from invoice where lease_id = $1', [LEASE]);
    const [invoice] = await db.query<{ id: string }>(
      `insert into invoice (lease_id, period_start, due_on, total_cents, status)
       values ($1, '2026-11-01', '2026-11-07', 1000000, 'issued') returning id`,
      [LEASE],
    );
    const { trimInvoicesAfter } = await import('../lib/billing');
    await db.withTransaction((run) => trimInvoicesAfter(run, LEASE, '2026-11-15'));
    const [after] = await db.query<{ total_cents: string }>('select total_cents::text from invoice where id = $1', [invoice!.id]);
    // 15 of November's 30 days at R10 000. It was R6 802,45: four years of 8% compounded twice.
    expect(Number(after!.total_cents)).toBe(500000);
  });
});

describe("an agent's lists", () => {
  it('show the leases and repairs of the account they work for', async () => {
    await db.query(
      `insert into landlord_member (landlord_id, sub, role) values ('11111111-1111-1111-1111-111111111111', 'sub-audit-agent', 'agent')`,
    );
    const agent = { sub: 'sub-audit-agent', groups: 'landlord' };
    const owner = await call('GET', '/leases');
    const leases = await call('GET', '/leases', agent);
    // They filtered on the owner's own sign-in, so an agent saw nothing.
    expect(owner.body.items.length).toBeGreaterThan(0);
    expect(leases.body.items.map((lease: { id: string }) => lease.id).sort())
      .toEqual(owner.body.items.map((lease: { id: string }) => lease.id).sort());
    await db.query(
      `insert into ticket (lease_id, category, severity, title, description, status, target_by, created_by)
       values ($1, 'plumbing', 'routine', 'Dripping tap', 'Kitchen tap drips', 'open', now() + interval '3 days', 'sub-tenant')`,
      [LEASE],
    );
    const tickets = await call('GET', '/tickets', agent);
    expect(tickets.body.items.length).toBeGreaterThan(0);
    expect(tickets.status).toBe(200);
    expect(tickets.body.items.length).toBe((await call('GET', '/tickets')).body.items.length);
  });
});
