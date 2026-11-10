import { beforeAll, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const PROPERTY = '22222222-2222-2222-2222-222222222222';

/** Terminations, fourth audit: who may withdraw a notice, a landlord-only "mutual" or backdated
    notice, the move-in baseline, deductions checked again at settlement, cancellation penalties,
    the refund clock, the exit statement's key, and the deposit reminders. */
type Opts = { sub?: string; groups?: string; body?: unknown; query?: Record<string, string> };
let call: (method: string, path: string, opts?: Opts) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let dates: typeof import('../domain/dates');

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://terminations-audit-4-${Date.now()}`;
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
      queryStringParameters: opts.query ?? {},
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

const today = () => dates.sastToday();
const plus = (days: number) => dates.addDaysIso(today(), days);
const asTenant = (sub: string) => ({ sub, groups: 'tenant' });

async function leaseFor(opts: { start: string; end: string; tenantSub?: string; unit?: string; previous?: string; applicant?: string; status?: string }) {
  const unit = opts.unit ?? randomUUID();
  const applicant = opts.applicant ?? randomUUID();
  const application = randomUUID();
  const lease = randomUUID();
  if (!opts.unit) {
    await db.query(
      `insert into unit (id, property_id, code, bedrooms, bathrooms, monthly_rent_cents, deposit_cents, status)
       values ($1, $2, $3, 1, 1, 700000, 700000, 'occupied')`,
      [unit, PROPERTY, `T${unit.slice(0, 5)}`],
    );
  }
  if (!opts.applicant) {
    await db.query(
      `insert into applicant (id, cognito_sub, first_name, last_name, id_number_enc, id_number_last4,
                              email, phone, employment_status, monthly_income_cents)
       values ($1, $2, 'Thandi', 'Tenant', '\\x00', '0001', $3, '+27820000000', 'employed', 2000000)`,
      [applicant, opts.tenantSub ?? null, `t-${applicant.slice(0, 6)}@example.co.za`],
    );
  }
  await db.query(
    `insert into application (id, unit_id, applicant_id, status, preferred_move_in)
     values ($1, $2, $3, 'approved', $4)`,
    [application, unit, applicant, opts.start],
  );
  await db.query(
    `insert into lease (id, application_id, unit_id, applicant_id, start_date, end_date,
                        monthly_rent_cents, escalation_pct, deposit_cents, status, previous_lease_id)
     values ($1, $2, $3, $4, $5, $6, 700000, 0, 700000, $8, $7)`,
    [lease, application, unit, applicant, opts.start, opts.end, opts.previous ?? null, opts.status ?? 'active'],
  );
  return { unit, applicant, application, lease };
}

async function inspection(lease: string, kind: 'incoming' | 'outgoing', scheduledFor: string, status = 'completed',
  findings: Array<[string, string, string]> = []) {
  const [row] = await db.query<{ id: string }>(
    `insert into inspection (lease_id, kind, status, scheduled_for, created_at, completed_at)
     values ($1, $2, $3, $4, ($4::date - 5)::timestamptz, case when $3 = 'completed' then $4::timestamptz end) returning id`,
    [lease, kind, status, scheduledFor],
  );
  const ids: string[] = [];
  for (const [room, item, condition] of findings) {
    const [finding] = await db.query<{ id: string }>(
      `insert into inspection_finding (inspection_id, room, item, condition) values ($1, $2, $3, $4) returning id`,
      [row!.id, room, item, condition],
    );
    ids.push(finding!.id);
  }
  return { id: row!.id, findings: ids };
}

async function termination(lease: string, effectiveOn: string, initiatedBy = 'tenant', givenOn = plus(-40)) {
  const [row] = await db.query<{ id: string }>(
    `insert into termination (lease_id, initiated_by, reason, notice_given_on, effective_on, notice_days)
     values ($1, $2, $3, $4, $5, 20) returning id`,
    [lease, initiatedBy, initiatedBy === 'landlord' ? 'breach_by_tenant' : initiatedBy === 'mutual' ? 'mutual' : 'early_tenant', givenOn, effectiveOn],
  );
  return row!.id;
}

const deposit = (lease: string, cents = 700000) =>
  db.query(`insert into deposit_ledger (lease_id, entry_type, amount_cents, note) values ($1, 'received', $2, 'Deposit')`, [lease, cents]);

const sentTo = async (lease: string, kind: string) =>
  db.query<{ recipient_sub: string; body: string; dedupe_key: string }>(
    'select recipient_sub, body, dedupe_key from notification where lease_id = $1 and kind = $2',
    [lease, kind],
  );

describe('items 8 and 17: only the party who gave a notice withdraws it', () => {
  it('a tenant cannot withdraw the landlord’s notice; the landlord can', async () => {
    const tenantSub = `sub-${randomUUID()}`;
    const { lease } = await leaseFor({ start: plus(-300), end: plus(300), tenantSub });
    const served = await call('POST', `/leases/${lease}/termination`, {
      body: { initiatedBy: 'landlord', reason: 'breach_by_tenant' },
    });
    expect(served.status).toBe(201);
    const byTenant = await call('POST', `/terminations/${served.body.id}/withdraw`, asTenant(tenantSub));
    expect(byTenant.status).toBe(403);
    const [row] = await db.query<{ status: string }>('select status from termination where id = $1', [served.body.id]);
    expect(row!.status).toBe('notice_served');
    expect((await call('POST', `/terminations/${served.body.id}/withdraw`)).status).toBe(200);
  });

  it('a landlord cannot withdraw the tenant’s notice; the tenant can', async () => {
    const tenantSub = `sub-${randomUUID()}`;
    const { lease } = await leaseFor({ start: plus(-300), end: plus(300), tenantSub });
    const served = await call('POST', `/leases/${lease}/termination`, {
      ...asTenant(tenantSub), body: { initiatedBy: 'tenant', reason: 'early_tenant' },
    });
    expect(served.status).toBe(201);
    expect((await call('POST', `/terminations/${served.body.id}/withdraw`)).status).toBe(403);
    expect((await call('POST', `/terminations/${served.body.id}/withdraw`, asTenant(tenantSub))).status).toBe(200);
  });

  // Audit 5: an agreed (confirmed) mutual notice is undone by neither side alone.
  it('neither party withdraws an agreed mutual notice alone', async () => {
    const tenantSub = `sub-${randomUUID()}`;
    const { lease } = await leaseFor({ start: plus(-300), end: plus(300), tenantSub });
    const id = await termination(lease, plus(20), 'mutual', today());
    expect((await call('POST', `/terminations/${id}/withdraw`, asTenant(tenantSub))).status).toBe(409);
    expect((await call('POST', `/terminations/${id}/withdraw`)).status).toBe(409);
  });

  it('GET /leases/{id} says who gave the notice', async () => {
    const tenantSub = `sub-${randomUUID()}`;
    const { lease } = await leaseFor({ start: plus(-300), end: plus(300), tenantSub });
    await termination(lease, plus(20), 'landlord', today());
    const got = await call('GET', `/leases/${lease}`, asTenant(tenantSub));
    expect(got.status).toBe(200);
    expect(got.body.termination).toMatchObject({ initiatedBy: 'landlord', awaitingTenant: false });
  });
});

describe('items 9 and 18: a landlord cannot end the lease alone by calling it mutual or backdating', () => {
  it('a mutual notice the landlord records waits for the tenant before the deposit can be settled', async () => {
    const tenantSub = `sub-${randomUUID()}`;
    const { lease } = await leaseFor({ start: plus(-100), end: plus(265), tenantSub });
    const served = await call('POST', `/leases/${lease}/termination`, { body: { initiatedBy: 'mutual', reason: 'mutual' } });
    expect(served.status).toBe(201);
    expect(served.body.effectiveOn).toBe(today());

    const preview = await call('GET', `/terminations/${served.body.id}/settlement`);
    expect(preview.body.blocker).toMatch(/tenant has not confirmed/);
    expect((await call('POST', `/terminations/${served.body.id}/settle`, { body: {} })).status).toBe(409);
    const got = await call('GET', `/leases/${lease}`);
    expect(got.body.termination).toMatchObject({ initiatedBy: 'mutual', awaitingTenant: true });
    const listed = (await call('GET', '/leases')).body.items.find((item: { id: string }) => item.id === lease);
    expect(listed).toMatchObject({ awaitingTenant: true });
    expect(new Set((await sentTo(lease, 'notice_confirm_requested')).map((r) => r.recipient_sub))).toEqual(new Set([tenantSub]));
    expect(await sentTo(lease, 'notice_served').then((rows) => rows.map((r) => r.recipient_sub))).not.toContain(tenantSub);

    // The landlord cannot confirm it for the tenant.
    expect((await call('POST', `/terminations/${served.body.id}/confirm`)).status).toBe(403);
    // The tenant who never agreed can undo it, even on the day it names.
    expect((await call('POST', `/terminations/${served.body.id}/withdraw`, asTenant(tenantSub))).status).toBe(200);
  });

  it('once the tenant confirms, it settles as before', async () => {
    const tenantSub = `sub-${randomUUID()}`;
    const { lease } = await leaseFor({ start: plus(-100), end: plus(265), tenantSub });
    const served = await call('POST', `/leases/${lease}/termination`, { body: { initiatedBy: 'mutual', reason: 'mutual' } });
    const confirmed = await call('POST', `/terminations/${served.body.id}/confirm`, asTenant(tenantSub));
    expect(confirmed.status).toBe(200);
    expect((await call('POST', `/terminations/${served.body.id}/confirm`, asTenant(tenantSub))).status).toBe(409);
    expect((await sentTo(lease, 'notice_confirmed')).map((r) => r.recipient_sub)).toContain('sub-landlord');
    // Confirmed, it is the tenant's agreement too: past its day it is not withdrawn alone.
    expect((await call('POST', `/terminations/${served.body.id}/withdraw`, asTenant(tenantSub))).status).toBe(409);
    expect((await call('POST', `/terminations/${served.body.id}/settle`, { body: {} })).status).toBe(200);
  });

  it('a tenant notice the landlord records with an earlier date also waits for the tenant', async () => {
    const tenantSub = `sub-${randomUUID()}`;
    const { lease } = await leaseFor({ start: plus(-100), end: plus(265), tenantSub });
    const served = await call('POST', `/leases/${lease}/termination`, {
      body: { initiatedBy: 'tenant', reason: 'early_tenant', noticeGivenOn: plus(-30), effectiveOn: today() },
    });
    expect(served.status).toBe(201);
    expect((await call('POST', `/terminations/${served.body.id}/settle`, { body: {} })).status).toBe(409);
    expect((await call('POST', `/terminations/${served.body.id}/withdraw`, asTenant(tenantSub))).status).toBe(200);
  });

  // Audit 5: dated today it waits too; only the tenant serving it themselves does not.
  it('a tenant notice the landlord records dated today waits as well', async () => {
    const tenantSub = `sub-${randomUUID()}`;
    const { lease } = await leaseFor({ start: plus(-100), end: plus(265), tenantSub });
    const served = await call('POST', `/leases/${lease}/termination`, { body: { initiatedBy: 'tenant', reason: 'early_tenant' } });
    expect(served.status).toBe(201);
    expect(served.body.awaitingTenant).toBe(true);
  });
});

describe('items 8 and 9 (review): a landlord’s unconfirmed entry is never stuck', () => {
  it('the landlord withdraws a mutual notice they recorded that the tenant never confirmed, even on its day', async () => {
    const tenantSub = `sub-${randomUUID()}`;
    const { lease } = await leaseFor({ start: plus(-100), end: plus(265), tenantSub });
    const served = await call('POST', `/leases/${lease}/termination`, { body: { initiatedBy: 'mutual', reason: 'mutual' } });
    expect(served.body.awaitingTenant).toBe(true);
    expect((await call('POST', `/terminations/${served.body.id}/withdraw`)).status).toBe(200);
  });

  it('the landlord withdraws a backdated tenant notice they recorded while it waits for the tenant', async () => {
    const { lease } = await leaseFor({ start: plus(-100), end: plus(265), tenantSub: `sub-${randomUUID()}` });
    const served = await call('POST', `/leases/${lease}/termination`, {
      body: { initiatedBy: 'tenant', reason: 'early_tenant', noticeGivenOn: plus(-30), effectiveOn: today() },
    });
    expect(served.status).toBe(201);
    expect((await call('POST', `/terminations/${served.body.id}/withdraw`)).status).toBe(200);
  });

  it('once the tenant confirms, the landlord no longer withdraws a tenant notice', async () => {
    const tenantSub = `sub-${randomUUID()}`;
    const { lease } = await leaseFor({ start: plus(-100), end: plus(265), tenantSub });
    const served = await call('POST', `/leases/${lease}/termination`, {
      body: { initiatedBy: 'tenant', reason: 'early_tenant', noticeGivenOn: plus(-30), effectiveOn: plus(1) },
    });
    expect((await call('POST', `/terminations/${served.body.id}/confirm`, asTenant(tenantSub))).status).toBe(200);
    expect((await call('POST', `/terminations/${served.body.id}/withdraw`)).status).toBe(403);
  });
});

describe('item 10: only a signed move-in inspection is the baseline, and the first one stands', () => {
  async function renewedWith(originalCondition: string) {
    const original = await leaseFor({ start: plus(-700), end: plus(-336), status: 'terminated' });
    await inspection(original.lease, 'incoming', plus(-700), 'completed', [['Kitchen', 'Cupboards', originalCondition]]);
    const current = await leaseFor({
      start: plus(-335), end: plus(30), unit: original.unit, applicant: original.applicant, previous: original.lease,
    });
    return { original, current };
  }

  it('an unsigned incoming inspection on the renewal does not replace the signed original', async () => {
    const { current } = await renewedWith('fair');
    await inspection(current.lease, 'incoming', plus(-5), 'in_progress', [['Kitchen', 'Cupboards', 'good']]);
    const terminationId = await termination(current.lease, plus(2));
    const outgoing = await inspection(current.lease, 'outgoing', plus(1), 'completed', [['Kitchen', 'Cupboards', 'poor']]);
    const deduction = await call('POST', `/terminations/${terminationId}/deductions`, {
      body: { findingId: outgoing.findings[0], description: 'Cupboard doors', amountCents: 100000 },
    });
    expect(deduction.status).toBe(400);
    expect(deduction.body.error.message).toMatch(/wear and tear/);
  });

  it('even a completed one on the renewal does not', async () => {
    const { current } = await renewedWith('fair');
    await inspection(current.lease, 'incoming', plus(-300), 'completed', [['Kitchen', 'Cupboards', 'good']]);
    const terminationId = await termination(current.lease, plus(2));
    const outgoing = await inspection(current.lease, 'outgoing', plus(1), 'completed', [['Kitchen', 'Cupboards', 'poor']]);
    const comparison = await call('GET', `/terminations/${terminationId}/comparison`);
    const item = comparison.body.items.find((row: { item: string }) => row.item === 'Cupboards');
    expect(item.incoming.condition).toBe('fair');
    expect((await call('POST', `/terminations/${terminationId}/deductions`, {
      body: { findingId: outgoing.findings[0], description: 'Cupboard doors', amountCents: 100000 },
    })).status).toBe(400);
  });

  it('an unsigned move-in inspection is no baseline at all', async () => {
    const { lease } = await leaseFor({ start: plus(-300), end: plus(30) });
    await inspection(lease, 'incoming', plus(-5), 'in_progress', [['Kitchen', 'Cupboards', 'good']]);
    const terminationId = await termination(lease, plus(2));
    const outgoing = await inspection(lease, 'outgoing', plus(1), 'completed', [['Kitchen', 'Cupboards', 'damaged']]);
    const deduction = await call('POST', `/terminations/${terminationId}/deductions`, {
      body: { findingId: outgoing.findings[0], description: 'Cupboard doors', amountCents: 100000 },
    });
    expect(deduction.status).toBe(400);
    expect(deduction.body.error.message).toMatch(/never recorded/);
  });

  it('a move-in inspection cannot be opened on a renewal, or once notice is served', async () => {
    const { current } = await renewedWith('fair');
    const renewal = await call('POST', `/leases/${current.lease}/inspections`, { body: { kind: 'incoming', scheduledFor: plus(1) } });
    expect(renewal.status).toBe(409);
    const { lease } = await leaseFor({ start: plus(-300), end: plus(100) });
    await termination(lease, plus(20));
    const late = await call('POST', `/leases/${lease}/inspections`, { body: { kind: 'incoming', scheduledFor: plus(1) } });
    expect(late.status).toBe(409);
  });
});

describe('item 11: deductions are checked again at settlement', () => {
  it('refuses to settle on a deduction whose finding was corrected to fair wear and tear', async () => {
    const { lease } = await leaseFor({ start: plus(-300), end: plus(100) });
    await inspection(lease, 'incoming', plus(-300), 'completed', [['Lounge', 'Walls', 'good']]);
    const terminationId = await termination(lease, today());
    const outgoing = await inspection(lease, 'outgoing', plus(-1), 'in_progress', [['Lounge', 'Walls', 'damaged']]);
    const added = await call('POST', `/terminations/${terminationId}/deductions`, {
      body: { findingId: outgoing.findings[0], description: 'Repaint lounge', amountCents: 200000 },
    });
    expect(added.status).toBe(201);
    await db.query(`update inspection_finding set condition = 'fair' where id = $1`, [outgoing.findings[0]]);
    await db.query(`update inspection set status = 'completed', completed_at = now() where id = $1`, [outgoing.id]);

    const preview = await call('GET', `/terminations/${terminationId}/settlement`);
    expect(preview.body.blocker).toMatch(/Repaint lounge/);
    const settled = await call('POST', `/terminations/${terminationId}/settle`, { body: {} });
    expect(settled.status).toBe(409);
    expect(settled.body.error.message).toMatch(/Repaint lounge/);
  });

  it('refuses a deduction left on an exit inspection that was replaced', async () => {
    const { lease } = await leaseFor({ start: plus(-300), end: plus(100) });
    await inspection(lease, 'incoming', plus(-300), 'completed', [['Lounge', 'Walls', 'good']]);
    const terminationId = await termination(lease, today());
    const first = await inspection(lease, 'outgoing', plus(-1), 'in_progress', [['Lounge', 'Walls', 'damaged']]);
    expect((await call('POST', `/terminations/${terminationId}/deductions`, {
      body: { findingId: first.findings[0], description: 'Repaint lounge', amountCents: 200000 },
    })).status).toBe(201);
    await db.query(`update inspection set status = 'missed' where id = $1`, [first.id]);
    await inspection(lease, 'outgoing', plus(-1), 'completed', [['Lounge', 'Walls', 'good']]);
    expect((await call('POST', `/terminations/${terminationId}/settle`, { body: {} })).status).toBe(409);
  });
});

describe('item 12: a cancellation penalty only when a fixed term is cut short', () => {
  it('refuses one on a lease already month to month', async () => {
    const { lease } = await leaseFor({ start: plus(-400), end: plus(-10), tenantSub: `sub-${randomUUID()}` });
    const served = await call('POST', `/leases/${lease}/termination`, {
      body: { initiatedBy: 'tenant', reason: 'early_tenant', penaltyCents: 500000 },
    });
    expect(served.status).toBe(400);
    expect(served.body.error.message).toMatch(/before its end date/);
  });

  it('refuses one when the notice runs to the end date anyway', async () => {
    const { lease } = await leaseFor({ start: plus(-355), end: plus(10), tenantSub: `sub-${randomUUID()}` });
    const served = await call('POST', `/leases/${lease}/termination`, {
      body: { initiatedBy: 'tenant', reason: 'early_tenant', penaltyCents: 500000 },
    });
    expect(served.status).toBe(400);
  });

  it('still allows one for a real early cancellation', async () => {
    const { lease } = await leaseFor({ start: plus(-100), end: plus(265), tenantSub: `sub-${randomUUID()}` });
    const served = await call('POST', `/leases/${lease}/termination`, {
      body: { initiatedBy: 'tenant', reason: 'early_tenant', penaltyCents: 500000 },
    });
    expect(served.status).toBe(201);
  });
});

describe('items 3 and 13: restoredOn lies between the lease end and today', () => {
  it('refuses a future date and one before the lease ended, in the preview and the settlement', async () => {
    const { lease } = await leaseFor({ start: plus(-300), end: plus(100) });
    const terminationId = await termination(lease, plus(-5));
    for (const restoredOn of [plus(30), plus(-6)]) {
      const preview = await call('GET', `/terminations/${terminationId}/settlement`, { query: { restoredOn } });
      expect(preview.status).toBe(400);
      const settled = await call('POST', `/terminations/${terminationId}/settle`, { body: { restoredOn } });
      expect(settled.status).toBe(400);
    }
    expect((await call('GET', `/terminations/${terminationId}/settlement`, { query: { restoredOn: plus(-2) } })).status).toBe(200);
  });
});

describe('items 4, 5, 7 and 15: the settlement of a refund made up partly of rent credit', () => {
  it('names the rent credit, keys the statement by its hash, and reminds the landlord of the whole refund', async () => {
    const tenantSub = `sub-${randomUUID()}`;
    const { lease } = await leaseFor({ start: plus(-300), end: plus(100), tenantSub });
    await inspection(lease, 'incoming', plus(-300), 'completed', [['Lounge', 'Walls', 'good']]);
    const terminationId = await termination(lease, plus(-12));
    const outgoing = await inspection(lease, 'outgoing', plus(-13), 'completed', [['Lounge', 'Walls', 'damaged']]);
    await deposit(lease, 700000);
    // A month cut short after it was paid in full: R3,000 of rent paid in advance.
    const [invoice] = await db.query<{ id: string }>(
      `insert into invoice (lease_id, period_start, due_on, total_cents, status)
       values ($1, $2, $2, 400000, 'paid') returning id`,
      [lease, `${plus(-12).slice(0, 7)}-01`],
    );
    await db.query(
      `insert into payment (lease_id, invoice_id, amount_cents, method, reference, received_on, recorded_by)
       values ($1, $2, 700000, 'eft', 'rent', $3, 'sub-landlord')`,
      [lease, invoice!.id, plus(-20)],
    );
    expect((await call('POST', `/terminations/${terminationId}/deductions`, {
      body: { findingId: outgoing.findings[0], description: 'Repaint lounge', amountCents: 700000 },
    })).status).toBe(201);

    const settled = await call('POST', `/terminations/${terminationId}/settle`, { body: { restoredOn: plus(-12) } });
    expect(settled.status).toBe(200);
    expect(settled.body.refundCents).toBe(300000);
    expect(settled.body.refundDueBy).toBe(plus(2));
    expect(settled.body.statementKey).toMatch(
      new RegExp(`^terminations/${terminationId}/deposit-statement-${settled.body.statementSha256}-[0-9a-f-]{36}\\.pdf$`));
    const { storage } = await import('../lib/storage');
    expect((await storage().get(settled.body.statementKey)).length).toBeGreaterThan(0);

    const { zar } = await import('../domain/money');
    const [message] = await sentTo(lease, 'deposit_settled');
    expect(message!.body).toContain(`Plus rent paid in advance ${zar(300000)}`);

    const { handler: sweep } = await import('../handlers/notifications-sweep');
    await sweep();
    const [reminder] = await sentTo(lease, 'refund_due_soon');
    expect(reminder?.body).toContain(zar(300000));
  });
});

describe('item 14: a deposit never settled is chased', () => {
  it('tells the landlord when the lease has ended unsettled, and again once the deadline has passed', async () => {
    const ended = await leaseFor({ start: plus(-300), end: plus(100) });
    await termination(ended.lease, plus(-1));
    const late = await leaseFor({ start: plus(-300), end: plus(100) });
    await termination(late.lease, plus(-20));
    await inspection(late.lease, 'outgoing', plus(-21), 'completed');
    const settledLease = await leaseFor({ start: plus(-300), end: plus(100) });
    const settledId = await termination(settledLease.lease, plus(-1));
    await db.query(`update termination set status = 'settled' where id = $1`, [settledId]);

    const { handler: sweep } = await import('../handlers/notifications-sweep');
    await sweep();
    const keys = async (lease: string) => (await sentTo(lease, 'deposit_unsettled')).map((r) => r.dedupe_key);
    expect(await keys(ended.lease)).toEqual([expect.stringMatching(/:ended:email$/)]);
    expect(await keys(late.lease)).toEqual([expect.stringMatching(/:overdue:email$/)]);
    expect(await keys(settledLease.lease)).toEqual([]);
    const [overdue] = await sentTo(late.lease, 'deposit_unsettled');
    expect(overdue!.body).toContain(plus(-13));
  });
});

describe('item 14 (review): the reminder uses settlement’s own rules', () => {
  it('counts an exit inspection the landlord signed alone after the tenant stayed away, and skips unconfirmed notices', async () => {
    const alone = await leaseFor({ start: plus(-300), end: plus(100) });
    await termination(alone.lease, plus(-10));
    const exit = await inspection(alone.lease, 'outgoing', plus(-11), 'awaiting_signatures');
    await db.query(
      `insert into inspection_signature (inspection_id, party, signed_at, signature_s3_key, pdf_sha256)
       values ($1, 'landlord', $2::timestamptz + interval '12 hours', 'sig', 'sha')`,
      [exit.id, plus(-11)],
    );
    const waiting = await leaseFor({ start: plus(-300), end: plus(100) });
    const waitingId = await termination(waiting.lease, plus(-1), 'mutual');
    await db.query('update termination set needs_tenant_confirmation = true where id = $1', [waitingId]);

    const { handler: sweep } = await import('../handlers/notifications-sweep');
    await sweep();
    const [reminder] = await sentTo(alone.lease, 'deposit_unsettled');
    // 7 days from the end date, not the 21 allowed with no inspection.
    expect(reminder!.dedupe_key).toMatch(/:overdue:email$/);
    expect(reminder!.body).toContain(plus(-3));
    expect(await sentTo(waiting.lease, 'deposit_unsettled')).toEqual([]);
  });
});

describe('item 5 (review): a double-submitted settle keeps the winner’s statement', () => {
  it('the losing request does not delete the statement the settled row points to', async () => {
    const { lease } = await leaseFor({ start: plus(-300), end: plus(100) });
    const terminationId = await termination(lease, plus(-5));
    await deposit(lease);
    const results = await Promise.all([
      call('POST', `/terminations/${terminationId}/settle`, { body: {} }),
      call('POST', `/terminations/${terminationId}/settle`, { body: {} }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const [row] = await db.query<{ statement_s3_key: string }>(
      'select statement_s3_key from termination where id = $1', [terminationId]);
    const { storage } = await import('../lib/storage');
    expect((await storage().get(row!.statement_s3_key)).length).toBeGreaterThan(0);
  });
});

describe('item 16: no lease-ending reminder once a renewal is in place', () => {
  it('skips a lease with a scheduled renewal', async () => {
    const old = await leaseFor({ start: plus(-360), end: plus(5) });
    await leaseFor({ start: plus(6), end: plus(371), unit: old.unit, applicant: old.applicant, previous: old.lease, status: 'scheduled' });
    const plain = await leaseFor({ start: plus(-360), end: plus(5) });
    const { handler: sweep } = await import('../handlers/notifications-sweep');
    await sweep();
    expect(await sentTo(old.lease, 'lease_ending_soon')).toEqual([]);
    expect((await sentTo(plain.lease, 'lease_ending_soon')).length).toBe(1);
  });
});
