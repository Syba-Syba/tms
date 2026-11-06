import { beforeAll, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** App audit, fourth round: what GET /leases tells the screens. */
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const PROPERTY = '22222222-2222-2222-2222-222222222222';
const APPLICANT = '44444444-4444-4444-4444-444444444444';
const LANDLORD_ID = '11111111-1111-1111-1111-111111111111';
const LANDLORD = { sub: 'sub-landlord', groups: '[landlord]' };
const TENANT = { sub: 'sub-tenant', groups: '[tenant]' };

let call: (method: string, path: string, body?: unknown, who?: { sub: string; groups: string }, query?: Record<string, string>) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let dates: typeof import('../domain/dates');

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://app-audit-4-${Date.now()}`;
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
  call = async (method, path, body, who = LANDLORD, query = {}) => {
    const event = {
      rawPath: path,
      headers: { 'content-type': 'application/json' },
      queryStringParameters: query,
      pathParameters: {},
      body: body ? JSON.stringify(body) : undefined,
      requestContext: {
        http: { method, path, sourceIp: '127.0.0.1', userAgent: 'test' },
        authorizer: { jwt: { claims: { sub: who.sub, 'cognito:groups': who.groups } } },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
    const result = (await handler(event)) as { statusCode: number; body?: string };
    return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : null };
  };
}, 120_000);

let unitNo = 0;
async function makeLease(opts: {
  start: string;
  end: string;
  rent?: number;
  status?: string;
  previousId?: string;
  applicantId?: string;
}) {
  unitNo += 1;
  const [unit] = await db.query<{ id: string }>(
    `insert into unit (property_id, code, bedrooms, bathrooms, monthly_rent_cents, deposit_cents, status)
     values ($1, $2, 1, 1, 900000, 900000, 'occupied') returning id`,
    [PROPERTY, `MB${unitNo}`],
  );
  const applicantId = opts.applicantId ?? APPLICANT;
  const [application] = await db.query<{ id: string }>(
    `insert into application (unit_id, applicant_id, status, preferred_move_in)
     values ($1, $2, 'approved', current_date) returning id`,
    [unit!.id, applicantId],
  );
  const [lease] = await db.query<{ id: string; ref: string }>(
    `insert into lease (application_id, unit_id, applicant_id, start_date, end_date,
                        monthly_rent_cents, escalation_pct, deposit_cents, status, previous_lease_id)
     values ($1, $2, $3, $4, $5, $6, 0, $6, $7, $8)
     returning id, 'LSE-' || lpad(ref_no::text, 5, '0') as ref`,
    [application!.id, unit!.id, applicantId, opts.start, opts.end, opts.rent ?? 900000, opts.status ?? 'active',
      opts.previousId ?? null],
  );
  return { id: lease!.id, ref: lease!.ref };
}


const listed = async (who: { sub: string; groups: string }, query?: Record<string, string>) =>
  (await call('GET', '/leases', undefined, who, query)).body.items as any[];

describe('GET /leases (audit 4, items 42, 47, 52, 53)', () => {
  it('counts as overdue only invoices past their due date', async () => {
    const today = dates.sastToday();
    const lease = await makeLease({ start: '2026-01-01', end: '2027-12-31' });
    await db.query(
      `insert into invoice (lease_id, period_start, due_on, total_cents, status) values
         ($1, '2026-01-01', ($2::date - 3), 500000, 'issued'),
         ($1, '2026-02-01', ($2::date + 5), 900000, 'issued')`,
      [lease.id, today],
    );
    const row = (await listed(LANDLORD)).find((item) => item.id === lease.id);
    expect(row.outstandingCents).toBe(1400000);
    expect(row.overdueCents).toBe(500000);
  });

  it('names the previous lease and the termination, and lists ended leases only on request', async () => {
    const first = await makeLease({ start: '2025-01-01', end: '2025-12-31', status: 'terminated' });
    const next = await makeLease({ start: '2026-01-01', end: '2026-12-31', previousId: first.id });
    const [termination] = await db.query<{ id: string }>(
      `insert into termination (lease_id, initiated_by, reason, notice_given_on, effective_on, notice_days, status)
       values ($1, 'landlord', 'end_of_term', '2025-11-01', '2025-12-31', 20, 'settled') returning id`,
      [first.id],
    );
    const plain = await listed(TENANT);
    expect(plain.some((item) => item.id === first.id)).toBe(false);
    expect(plain.find((item) => item.id === next.id).previousLeaseId).toBe(first.id);

    const withEnded = await listed(TENANT, { include: 'ended' });
    const ended = withEnded.find((item) => item.id === first.id);
    expect(ended.status).toBe('terminated');
    expect(ended.terminationId).toBe(termination!.id);
  });
});
