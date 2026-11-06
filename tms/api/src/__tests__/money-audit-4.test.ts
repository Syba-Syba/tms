import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Money audit, fourth round: invoices born overdue, downgrades past their unit limit, money
    after settlement, renewals that strand arrears and slips, legal notices given up on, and
    report ranges that are not dates. The concurrency finding is in money-race-audit-4. */
const alerts = vi.hoisted(() => [] as Array<{ key: string; subject: string; detail: string }>);
vi.mock('../lib/alerts', async (original) => ({
  ...(await original<typeof import('../lib/alerts')>()),
  alert: async (key: string, subject: string, detail: string) => {
    alerts.push({ key, subject, detail });
  },
}));

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const PROPERTY = '22222222-2222-2222-2222-222222222222';
const APPLICANT = '44444444-4444-4444-4444-444444444444';
const LANDLORD_ID = '11111111-1111-1111-1111-111111111111';
const LANDLORD = { sub: 'sub-landlord', groups: '[landlord]' };

let call: (method: string, path: string, body?: unknown, who?: { sub: string; groups: string }) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let bill: typeof import('../handlers/invoices-run').handler;
let arrearsRun: typeof import('../handlers/arrears-run');
let activation: typeof import('../lib/activation');

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://money-audit-4-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'tms-storage-'));
  process.env.KMS_DRIVER = 'local';
  // Every send fails without a network: what exercises the retry of a legal notice.
  process.env.NOTIFY_MODE = 'smtp';
  delete process.env.SMTP_URL;

  db = await import('../lib/db');
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  for (const file of all.filter((n) => !n.includes('seed'))) await db.execScript(read(file));
  for (const file of all.filter((n) => n.includes('seed'))) await db.execScript(read(file));
  ({ handler: bill } = await import('../handlers/invoices-run'));
  arrearsRun = await import('../handlers/arrears-run');
  activation = await import('../lib/activation');

  const { handler } = await import('../api');
  call = async (method, path, body, who = LANDLORD) => {
    const [rawPath, search] = path.split('?');
    const event = {
      rawPath,
      headers: { 'content-type': 'application/json' },
      queryStringParameters: Object.fromEntries(new URLSearchParams(search ?? '')),
      pathParameters: {},
      body: body ? JSON.stringify(body) : undefined,
      requestContext: {
        http: { method, path: rawPath, sourceIp: '127.0.0.1', userAgent: 'test' },
        authorizer: { jwt: { claims: { sub: who.sub, 'cognito:groups': who.groups } } },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
    const result = (await handler(event)) as { statusCode: number; body?: string };
    return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : null };
  };
}, 120_000);

const unitCount = async () =>
  Number((await db.query<{ n: string }>(
    'select count(*)::text as n from unit u join property p on p.id = u.property_id where p.landlord_id = $1',
    [LANDLORD_ID],
  ))[0]!.n);

let unitNo = 0;
async function makeLease(opts: { start: string; end: string; status?: string; previousId?: string; activatedAt?: string }) {
  unitNo += 1;
  const [unit] = await db.query<{ id: string }>(
    `insert into unit (property_id, code, bedrooms, bathrooms, monthly_rent_cents, deposit_cents, status)
     values ($1, $2, 1, 1, 900000, 900000, 'occupied') returning id`,
    [PROPERTY, `M4-${unitNo}`],
  );
  return leaseOn(unit!.id, opts);
}

async function leaseOn(unitId: string, opts: { start: string; end: string; status?: string; previousId?: string; activatedAt?: string }) {
  const [application] = await db.query<{ id: string }>(
    `insert into application (unit_id, applicant_id, status, preferred_move_in)
     values ($1, $2, 'approved', current_date) returning id`,
    [unitId, APPLICANT],
  );
  const [lease] = await db.query<{ id: string }>(
    `insert into lease (application_id, unit_id, applicant_id, start_date, end_date,
                        monthly_rent_cents, escalation_pct, deposit_cents, status, previous_lease_id, activated_at)
     values ($1, $2, $3, $4, $5, 900000, 0, 900000, $6, $7, $8::timestamptz) returning id`,
    [application!.id, unitId, APPLICANT, opts.start, opts.end, opts.status ?? 'active', opts.previousId ?? null,
      opts.activatedAt ?? null],
  );
  return { id: lease!.id, unitId };
}

let slipNo = 0;
async function pendingSlip(leaseId: string, target: 'invoice' | 'deposit', amountCents: number, paidOn: string) {
  slipNo += 1;
  const [proof] = await db.query<{ id: string }>(
    `insert into payment_proof (lease_id, target, amount_cents, paid_on, reference, s3_key, content_type, size_bytes,
                                status, submitted_by, submitted_at)
     values ($1, $2, $3, $4, 'slip', $5, 'application/pdf', 10, 'pending', 'sub-tenant', now()) returning id`,
    [leaseId, target, amountCents, paidOn, `proofs/m4-${slipNo}.pdf`],
  );
  return proof!.id;
}

/** The renewal of a lease, on the same unit, ready to go live. */
async function renew(old: { id: string; unitId: string }, start: string, end: string) {
  const renewal = await leaseOn(old.unitId, { start, end, status: 'scheduled', previousId: old.id });
  await db.withTransaction((run) =>
    activation.activateScheduledLease(run, { id: renewal.id, previous_lease_id: old.id, unit_id: old.unitId }),
  );
  return renewal;
}

async function invoice(leaseId: string, period: string, cents: number, dueOn = period) {
  const [row] = await db.query<{ id: string }>(
    `insert into invoice (lease_id, period_start, due_on, total_cents) values ($1, $2, $3, $4) returning id`,
    [leaseId, period, dueOn, cents],
  );
  await db.query(
    `insert into invoice_line (invoice_id, kind, description, amount_cents) values ($1, 'rent', $2, $3)`,
    [row!.id, `Rent · X · ${period.slice(0, 7)}`, cents],
  );
  return row!.id;
}

describe('a downgrade waiting for its payment (finding 1)', () => {
  const setPro = () =>
    db.query(
      `update subscription set status = 'active', plan = 'pro', provider = 'local', provider_token = 'tok-ma4',
              pending_plan = null, current_period_end = current_date + 20 where landlord_id = $1`,
      [LANDLORD_ID],
    );
  const addUnit = () =>
    call('POST', `/properties/${PROPERTY}/units`, {
      code: `D${(unitNo += 1)}`, bedrooms: 1, bathrooms: 1, monthlyRentCents: 500000, depositCents: 500000,
    });

  it('holds new units to the smaller plan while the change waits', async () => {
    await setPro();
    expect(await unitCount()).toBeLessThanOrEqual(5);
    const changed = await call('POST', '/billing/plan', { action: 'change', plan: 'starter' });
    expect(changed.status).toBe(200);
    while ((await unitCount()) < 5) expect((await addUnit()).status).toBe(201);
    const over = await addUnit();
    expect(over.status).toBe(402);
    expect(over.body.error.message).toMatch(/change to Starter covers 5 units/);
  });

  it('does not apply the downgrade when the units have grown past it by the time it is paid', async () => {
    // Units that got in before the cap, or by any other door.
    for (let n = 0; n < 3; n += 1) {
      await db.query(
        `insert into unit (property_id, code, bedrooms, bathrooms, monthly_rent_cents, deposit_cents, status)
         values ($1, $2, 1, 1, 500000, 500000, 'vacant')`,
        [PROPERTY, `DX${n}`],
      );
    }
    alerts.length = 0;
    const { applyPaymentNotice } = await import('../lib/billing-events');
    const paid = await applyPaymentNotice({
      provider: 'local', externalId: 'ma4-1', checkoutId: null, token: 'tok-ma4', outcome: 'paid', amountCents: 19_900, payload: {},
    });
    expect(paid).toEqual({ applied: true });
    const [after] = await db.query<{ plan: string; pending_plan: string | null }>(
      'select plan, pending_plan from subscription where landlord_id = $1',
      [LANDLORD_ID],
    );
    expect(after).toEqual({ plan: 'pro', pending_plan: null });
    const [event] = await db.query<{ problem: string | null }>(
      `select problem from billing_event where external_id = 'ma4-1'`,
    );
    expect(event!.problem).toMatch(/Starter not applied: 8 units/);
    expect(alerts.map((a) => a.subject)).toContain('A plan downgrade was refused');

    // The rest of this file runs on the trial, with room for the leases it makes.
    await db.query(
      `update subscription set status = 'trialing', plan = null, provider_token = null, current_period_end = null,
              pending_plan = null, trial_ends_on = current_date + 30 where landlord_id = $1`,
      [LANDLORD_ID],
    );
  });
});

describe('an invoice for rent from before the lease went live (finding 0)', () => {
  it('falls due the day the lease went live, so the first arrears step is the first reminder', async () => {
    // Starts 28 October, last signature 2 November (09:00 in Johannesburg).
    const lease = await makeLease({ start: '2026-10-28', end: '2027-10-27', activatedAt: '2026-11-02T07:00:00Z' });
    await bill({ periods: ['2026-10-01', '2026-11-01'], now: new Date('2026-11-02T10:00:00+02:00') });
    const invoices = await db.query<{ period_start: string; due_on: string }>(
      'select period_start::text, due_on::text from invoice where lease_id = $1 order by period_start',
      [lease.id],
    );
    expect(invoices).toEqual([
      { period_start: '2026-10-01', due_on: '2026-11-02' },
      { period_start: '2026-11-01', due_on: '2026-11-02' },
    ]);
    const [issued] = await db.query<{ body: string }>(
      `select body from notification where lease_id = $1 and kind = 'invoice_issued' and dedupe_key like '%2026-10-01:email'`,
      [lease.id],
    );
    expect(issued!.body).toMatch(/due 2026-11-02/);

    await arrearsRun.handler(new Date('2026-11-03T05:15:00+02:00'));
    const steps = await arrearsRun.openSteps(lease.id);
    expect(steps.map((step) => step.step)).toEqual(['reminder_1']);
    expect(await db.query(`select 1 from notification where lease_id = $1 and kind = 'arrears_letter_ready'`, [lease.id]))
      .toHaveLength(0);
  });

  it('still falls due on the 1st for a lease that was live before the month began', async () => {
    const lease = await makeLease({ start: '2026-01-01', end: '2026-12-31', activatedAt: '2025-12-20T07:00:00Z' });
    await bill({ periods: ['2026-10-01'], now: new Date('2026-10-01T06:00:00+02:00') });
    const [row] = await db.query<{ due_on: string }>('select due_on::text from invoice where lease_id = $1', [lease.id]);
    expect(row!.due_on).toBe('2026-10-01');
  });

  it('falls due on the day it is billed when a missed month is caught up later', async () => {
    // Live since January; the run did not go in October, and catches the month up on 6 November.
    const lease = await makeLease({ start: '2026-01-01', end: '2026-12-31', activatedAt: '2025-12-20T07:00:00Z' });
    await bill({ periods: ['2026-10-01', '2026-11-01'], now: new Date('2026-11-06T06:00:00+02:00') });
    const invoices = await db.query<{ period_start: string; due_on: string }>(
      'select period_start::text, due_on::text from invoice where lease_id = $1 order by period_start',
      [lease.id],
    );
    expect(invoices).toEqual([
      { period_start: '2026-10-01', due_on: '2026-11-06' },
      { period_start: '2026-11-01', due_on: '2026-11-01' },
    ]);
  });
});

describe('deposit money after the deposit is settled (finding 6)', () => {
  it('refuses a deposit receipt or a deposit slip on a terminated lease', async () => {
    const lease = await makeLease({ start: '2025-01-01', end: '2025-12-31', status: 'terminated' });
    const recorded = await call('POST', `/leases/${lease.id}/payments`, {
      target: 'deposit', amountCents: 500000, receivedOn: '2026-01-10',
    });
    expect(recorded.status).toBe(409);
    const slip = await pendingSlip(lease.id, 'deposit', 500000, '2026-01-10');
    const accepted = await call('POST', `/payment-proofs/${slip}/decision`, { decision: 'accept' });
    expect(accepted.status).toBe(409);
    expect(await db.query('select 1 from deposit_ledger where lease_id = $1', [lease.id])).toHaveLength(0);
  });

  it('refuses a deposit receipt once the termination is settled, even while the lease is still active', async () => {
    const lease = await makeLease({ start: '2025-01-01', end: '2026-12-31' });
    await db.query(
      `insert into termination (lease_id, initiated_by, reason, notice_given_on, effective_on, notice_days, status)
       values ($1, 'tenant', 'early_tenant', '2026-08-01', '2026-09-30', 30, 'settled')`,
      [lease.id],
    );
    const recorded = await call('POST', `/leases/${lease.id}/payments`, {
      target: 'deposit', amountCents: 500000, receivedOn: '2026-10-10',
    });
    expect(recorded.status).toBe(409);
  });

  it('still records a deposit on a live lease', async () => {
    const lease = await makeLease({ start: '2026-01-01', end: '2026-12-31' });
    const recorded = await call('POST', `/leases/${lease.id}/payments`, {
      target: 'deposit', amountCents: 500000, receivedOn: '2026-01-10',
    });
    expect(recorded.status).toBe(201);
  });
});

describe('a renewal going live (findings 74, 75, 78)', () => {
  it('carries the arrears case across, so a pause holds and no second letter is allowed', async () => {
    const old = await makeLease({ start: '2025-11-01', end: '2026-10-31' });
    await invoice(old.id, '2026-10-01', 900000);
    await arrearsRun.handler(new Date('2026-10-11T05:15:00+02:00'));
    const paused = await call('POST', `/leases/${old.id}/arrears/pause`, { until: '2026-11-30', reason: 'Payment plan agreed' });
    expect(paused.status).toBeLessThan(300);
    const [before] = await db.query<{ id: string; paused_until: string }>(
      'select id, paused_until::text from arrears_case where lease_id = $1 and closed_on is null',
      [old.id],
    );

    const renewal = await renew(old, '2026-11-01', '2027-10-31');
    await arrearsRun.handler(new Date('2026-11-02T05:15:00+02:00'));

    const [after] = await db.query<{ id: string; paused_until: string }>(
      'select id, paused_until::text from arrears_case where lease_id = $1 and closed_on is null',
      [renewal.id],
    );
    expect(after).toEqual(before);
    expect(await db.query(
      `select 1 from notification where lease_id = $1 and kind in ('arrears_reminder_7', 'arrears_letter_ready')`,
      [renewal.id],
    )).toHaveLength(0);
  });

  it('moves a pending slip to the renewal, so it can be accepted against the moved invoice', async () => {
    const old = await makeLease({ start: '2025-11-01', end: '2026-10-31' });
    const october = await invoice(old.id, '2026-10-01', 900000);
    const slip = await pendingSlip(old.id, 'invoice', 900000, '2026-10-30');
    const renewal = await renew(old, '2026-11-01', '2027-10-31');

    const accepted = await call('POST', `/payment-proofs/${slip}/decision`, { decision: 'accept' });
    expect(accepted.status).toBe(200);
    const [paid] = await db.query<{ status: string; lease_id: string }>('select status, lease_id from invoice where id = $1', [october]);
    expect(paid).toEqual({ status: 'paid', lease_id: renewal.id });
  });

  it('moves a pending deposit slip, so the deposit lands on the ledger that is still read', async () => {
    const old = await makeLease({ start: '2025-11-01', end: '2026-10-31' });
    const slip = await pendingSlip(old.id, 'deposit', 100000, '2026-10-30');
    const renewal = await renew(old, '2026-11-01', '2027-10-31');
    const accepted = await call('POST', `/payment-proofs/${slip}/decision`, { decision: 'accept' });
    expect(accepted.status).toBe(200);
    const ledger = await db.query<{ lease_id: string }>('select lease_id from deposit_ledger where proof_id = $1', [slip]);
    expect(ledger).toEqual([{ lease_id: renewal.id }]);
  });

  it('keeps the old lease’s rent for a split month off the list of removable charges', async () => {
    const old = await makeLease({ start: '2025-10-15', end: '2026-10-14' });
    await invoice(old.id, '2026-10-01', 406452);
    const renewal = await leaseOn(old.unitId, { start: '2026-10-15', end: '2027-10-14', status: 'scheduled', previousId: old.id });
    await invoice(renewal.id, '2026-10-01', 493548);
    await db.withTransaction((run) =>
      activation.activateScheduledLease(run, { id: renewal.id, previous_lease_id: old.id, unit_id: old.unitId }),
    );

    const [merged] = await db.query<{ id: string; kind: string }>(
      `select il.id, il.kind from invoice_line il join invoice i on i.id = il.invoice_id
        where i.lease_id = $1 and il.amount_cents = 406452`,
      [renewal.id],
    );
    expect(merged!.kind).toBe('prior_rent');
    const shown = await call('GET', `/leases/${renewal.id}`);
    expect(shown.status).toBe(200);
    expect(shown.body.charges ?? []).toEqual([]);
    const removed = await call('DELETE', `/leases/${renewal.id}/charges/${merged!.id}`);
    expect(removed.status).toBe(404);
  });
});

describe('a legal notice the mail server will not take (finding 76)', () => {
  const queued = async (category: string, attempts: number, hoursOld: number) => {
    const [row] = await db.query<{ id: string }>(
      `insert into notification (recipient_sub, recipient_to, channel, category, kind, urgent, subject, body, attempts, created_at)
       values ('sub-tenant', 'tenant@example.co.za', 'email', $1, 'letter_of_demand', true, 's', 'b', $2,
               now() - ($3 || ' hours')::interval)
       returning id`,
      [category, attempts, String(hoursOld)],
    );
    return row!.id;
  };
  const state = async (id: string) =>
    (await db.query<{ status: string; attempts: number }>('select status, attempts from notification where id = $1', [id]))[0]!;

  it('keeps retrying past the attempt ceiling and past a day, and tells the operator', async () => {
    await db.query(`update notification set status = 'sent' where status = 'pending'`);
    const id = await queued('deadline', 4, 30);
    alerts.length = 0;
    const { handler: dispatch } = await import('../handlers/notifications-dispatch');
    await dispatch();
    expect(await state(id)).toEqual({ status: 'pending', attempts: 5 });
    expect(alerts.map((a) => a.key)).toContain('notification-deadline-failing');
  });

  it('still gives up on an ordinary message', async () => {
    await db.query(`update notification set status = 'sent' where status = 'pending'`);
    const id = await queued('money', 4, 1);
    const { handler: dispatch } = await import('../handlers/notifications-dispatch');
    await dispatch();
    expect(await state(id)).toEqual({ status: 'failed', attempts: 5 });
  });
});

describe('the income and expense report range (finding 77)', () => {
  it('refuses a day that does not exist instead of failing with a 500', async () => {
    const response = await call('GET', '/reports/income-expense?from=2026-02-31&to=2026-03-01');
    expect(response.status).toBe(400);
  });

  it('refuses a range of centuries', async () => {
    const response = await call('GET', '/reports/income-expense?from=0001-01-01&to=9999-12-31');
    expect(response.status).toBe(400);
  });

  it('refuses year 0000, which JavaScript reads as a day and Postgres does not', async () => {
    const response = await call('GET', '/reports/income-expense?from=0000-01-01&to=0000-12-31');
    expect(response.status).toBe(400);
  });

  it('still answers for a tax year', async () => {
    const response = await call('GET', '/reports/income-expense?from=2026-03-01&to=2027-02-28');
    expect(response.status).toBe(200);
    expect(response.body.months).toHaveLength(12);
  });
});
