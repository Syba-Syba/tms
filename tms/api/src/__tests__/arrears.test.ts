import { beforeAll, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { daysBetween, letterAllowed, reminderDue, remedyBy, type Step } from '../domain/arrears';
import { addDaysIso, sastToday } from '../domain/dates';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

describe('the arrears ladder', () => {
  const none = new Set<Step>();
  it('sends nothing on the due date and the first reminder on day 1', () => {
    expect(reminderDue(0, none)).toBeNull();
    expect(reminderDue(1, none)).toBe('reminder_1');
    expect(reminderDue(2, new Set<Step>(['reminder_1']))).toBeNull();
    expect(reminderDue(3, new Set<Step>(['reminder_1']))).toBe('reminder_3');
  });

  it('sends only the highest reminder due after a gap, never the ones below it', () => {
    expect(reminderDue(9, none)).toBe('reminder_7');
    expect(reminderDue(9, new Set<Step>(['reminder_7']))).toBeNull();
    expect(reminderDue(4, new Set<Step>(['reminder_7']))).toBeNull();
  });

  it('stops reminding once the letter has gone', () => {
    expect(reminderDue(8, new Set<Step>(['reminder_1', 'letter_of_demand']))).toBeNull();
  });

  it('allows the letter from day 7, once', () => {
    expect(letterAllowed(6, none)).toBe(false);
    expect(letterAllowed(7, none)).toBe(true);
    expect(letterAllowed(30, new Set<Step>(['letter_of_demand']))).toBe(false);
  });

  it('gives 20 business days to pay, skipping weekends and public holidays', () => {
    // Sent Monday 1 December 2025. 16, 25 and 26 December and 1 January are holidays, so
    // the 20th business day is Friday 2 January.
    expect(remedyBy('2025-12-01')).toBe('2026-01-02');
    expect(daysBetween('2026-10-01', '2026-10-08')).toBe(7);
  });
});

type As = { sub: string; groups: string };
const LANDLORD: As = { sub: 'sub-landlord', groups: 'landlord' };
const TENANT: As = { sub: 'sub-tenant', groups: 'tenant' };
const LEASE = '66666666-6666-6666-6666-666666666666';

let call: (method: string, path: string, as: As, body?: unknown) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let storage: typeof import('../lib/storage');
let run: (now: Date) => Promise<Record<string, number>>;

const today = sastToday();
const dueOn = addDaysIso(today, -10);
const at = (iso: string) => new Date(`${iso}T08:00:00Z`);
const day = (n: number) => at(addDaysIso(dueOn, n));
const kinds = async (sub: string) =>
  (await db.query<{ kind: string }>(
    `select distinct kind from notification where recipient_sub = $1 and kind like any (array['arrears%', 'letter_of_demand'])
      order by kind`,
    [sub],
  )).map((row) => row.kind);

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://arrears-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'tms-arrears-'));
  process.env.KMS_DRIVER = 'local';

  db = await import('../lib/db');
  storage = await import('../lib/storage');
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  for (const file of all.filter((n) => !n.includes('seed'))) await db.execScript(read(file));
  for (const file of all.filter((n) => n.includes('seed'))) await db.execScript(read(file));

  ({ handler: run } = await import('../handlers/arrears-run'));
  const { handler } = await import('../api');
  call = async (method, path, as, body) => {
    const [rawPath, rawQuery] = path.split('?');
    const event = {
      rawPath,
      headers: { 'content-type': 'application/json' },
      queryStringParameters: Object.fromEntries(new URLSearchParams(rawQuery ?? '')),
      pathParameters: {},
      body: body ? JSON.stringify(body) : undefined,
      requestContext: {
        http: { method, path: rawPath, sourceIp: '127.0.0.1', userAgent: 'test' },
        authorizer: { jwt: { claims: { sub: as.sub, 'cognito:groups': `[${as.groups}]` } } },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
    const result = (await handler(event)) as { statusCode: number; body?: string };
    return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : null };
  };
}, 120_000);

describe('arrears on a lease', () => {
  let invoiceId: string;

  it('opens a case and sends the day 1 reminder once', async () => {
    const [row] = await db.query<{ id: string }>(
      `insert into invoice (lease_id, period_start, due_on, total_cents) values ($1, $2, $3, 850000) returning id`,
      [LEASE, `${dueOn.slice(0, 7)}-01`, dueOn],
    );
    invoiceId = row!.id;
    expect((await run(at(dueOn))).reminders).toBe(0);
    expect((await run(day(1))).reminders).toBe(1);
    expect((await run(day(1))).reminders).toBe(0);
    expect(await kinds('sub-tenant')).toEqual(['arrears_reminder_1']);
  });

  it('holds reminders while a slip waits for the landlord', async () => {
    const [proof] = await db.query<{ id: string }>(
      `insert into payment_proof (lease_id, target, amount_cents, paid_on, s3_key, status, content_type, size_bytes, submitted_by)
       values ($1, 'invoice', 850000, $2, 'payment-proofs/test.pdf', 'pending', 'application/pdf', 10, 'sub-tenant') returning id`,
      [LEASE, addDaysIso(dueOn, 2)],
    );
    expect((await run(day(3))).held).toBe(1);
    await db.query(`update payment_proof set status = 'rejected', reject_reason = 'Wrong account' where id = $1`, [proof!.id]);
    expect((await run(day(3))).reminders).toBe(1);
  });

  it('sends the final reminder on day 7 and tells the landlord the letter is ready', async () => {
    expect((await run(day(5))).reminders).toBe(0);
    const counts = await run(day(7));
    expect(counts.reminders).toBe(1);
    expect(await kinds('sub-tenant')).toEqual(['arrears_reminder_1', 'arrears_reminder_3', 'arrears_reminder_7']);
    expect(await kinds('sub-landlord')).toEqual(['arrears_letter_ready']);
  });

  it('shows the ladder to both parties, and the letter control to the landlord only', async () => {
    const landlord = await call('GET', `/leases/${LEASE}/arrears`, LANDLORD);
    expect(landlord.status).toBe(200);
    expect(landlord.body.owing).toMatchObject({ outstandingCents: 850000, daysLate: 10 });
    expect(landlord.body.case.steps.map((step: { step: string }) => step.step)).toEqual([
      'reminder_1', 'reminder_3', 'reminder_7',
    ]);
    expect(landlord.body.letter.allowed).toBe(true);
    const tenant = await call('GET', `/leases/${LEASE}/arrears`, TENANT);
    expect(tenant.status).toBe(200);
    expect(tenant.body.letter).toBeNull();
  });

  it('lets only the landlord send the letter, once, and files it on the lease', async () => {
    expect((await call('POST', `/leases/${LEASE}/arrears/letter`, TENANT)).status).toBe(403);
    const sent = await call('POST', `/leases/${LEASE}/arrears/letter`, LANDLORD);
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ outstandingCents: 850000, remedyBy: remedyBy(today) });
    const bytes = await storage.storage().get(sent.body.key);
    expect(Buffer.from(bytes).subarray(0, 4).toString()).toBe('%PDF');
    expect(await kinds('sub-tenant')).toContain('letter_of_demand');
    expect((await call('POST', `/leases/${LEASE}/arrears/letter`, LANDLORD)).status).toBe(409);

    const viewed = await call('POST', '/files/view', TENANT, { key: sent.body.key });
    expect(viewed.status).toBe(200);
  });

  it('pauses with a reason and an end date no more than 60 days out', async () => {
    const tooLong = await call('POST', `/leases/${LEASE}/arrears/pause`, LANDLORD, {
      until: addDaysIso(today, 90), reason: 'Payment plan',
    });
    expect(tooLong.status).toBe(400);
    const noReason = await call('POST', `/leases/${LEASE}/arrears/pause`, LANDLORD, { until: addDaysIso(today, 10) });
    expect(noReason.status).toBe(400);
    expect(
      (await call('POST', `/leases/${LEASE}/arrears/pause`, TENANT, { until: addDaysIso(today, 10), reason: 'x x x' })).status,
    ).toBe(403);
    const paused = await call('POST', `/leases/${LEASE}/arrears/pause`, LANDLORD, {
      until: addDaysIso(today, 10), reason: 'Payment plan agreed',
    });
    expect(paused.status).toBe(200);
    expect((await call('GET', `/leases/${LEASE}/arrears`, LANDLORD)).body.case.pausedUntil).toBe(addDaysIso(today, 10));
    expect((await call('POST', `/leases/${LEASE}/arrears/pause`, LANDLORD, { until: null })).status).toBe(200);
  });

  it('closes the case once the tenant is paid up, and keeps the history', async () => {
    await db.query(
      `insert into payment (lease_id, invoice_id, amount_cents, method, received_on, recorded_by)
       values ($1, $2, 850000, 'eft', $3, 'sub-landlord')`,
      [LEASE, invoiceId, today],
    );
    await db.query(`update invoice set status = 'paid' where id = $1`, [invoiceId]);
    expect((await run(at(today))).closed).toBe(1);
    const view = await call('GET', `/leases/${LEASE}/arrears`, LANDLORD);
    expect(view.body.owing).toBeNull();
    expect(view.body.case).toBeNull();
    expect(view.body.history[0].steps).toHaveLength(4);
  });

  it('shows the stage on the arrears report', async () => {
    // A fresh debt on day 3: the report names the reminder already sent.
    const due = addDaysIso(today, -3);
    await db.query(
      `insert into invoice (lease_id, period_start, due_on, total_cents) values ($1, $2, $3, 850000)`,
      [LEASE, `${Number(due.slice(0, 4)) - 1}${due.slice(4, 7)}-01`, due],
    );
    await run(at(today));
    const report = await call('GET', '/reports/arrears', LANDLORD);
    expect(report.status).toBe(200);
    expect(report.body.items[0]).toMatchObject({ leaseId: LEASE, stage: 'reminder_3', stageOn: today });
  });
});
