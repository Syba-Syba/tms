import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

/** The exit statement's input, captured so a test can see which comparisons it was given. */
const rendered: Array<{ comparisons: Array<{ room: string; item: string; incomingCondition: string }> }> = [];
vi.mock('../lib/pdf', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/pdf')>();
  return {
    ...original,
    renderExitStatementPdf: async (input: Parameters<typeof original.renderExitStatementPdf>[0]) => {
      rendered.push(input as never);
      return original.renderExitStatementPdf(input);
    },
  };
});

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const PROPERTY = '22222222-2222-2222-2222-222222222222';

/** Workflow fixes, third pass: renewals and the move-in baseline, rebooking the exit inspection,
    backdated notices, imported tenants, mandatory notices, CPA reminder timing, withdrawing a
    notice, the rent credit at settlement, stuck tickets and SAST deadlines. */
type Opts = { sub?: string; groups?: string; body?: unknown };
let call: (method: string, path: string, opts?: Opts) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let dates: typeof import('../domain/dates');

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://workflows-audit-3-${Date.now()}`;
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

afterEach(() => {
  vi.useRealTimers();
});

const today = () => dates.sastToday();
const plus = (days: number) => dates.addDaysIso(today(), days);

/** A unit with an active lease. Without `tenantSub` the tenant was imported and has no account. */
async function leaseFor(opts: { start: string; end: string; tenantSub?: string; unit?: string; previous?: string; applicant?: string; status?: string }) {
  const unit = opts.unit ?? randomUUID();
  const applicant = opts.applicant ?? randomUUID();
  const application = randomUUID();
  const lease = randomUUID();
  if (!opts.unit) {
    await db.query(
      `insert into unit (id, property_id, code, bedrooms, bathrooms, monthly_rent_cents, deposit_cents, status)
       values ($1, $2, $3, 1, 1, 700000, 700000, 'occupied')`,
      [unit, PROPERTY, `W${unit.slice(0, 5)}`],
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
    `insert into inspection (lease_id, kind, status, scheduled_for, created_at)
     values ($1, $2, $3, $4, ($4::date - 5)::timestamptz) returning id`,
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

async function termination(lease: string, effectiveOn: string, givenOn = plus(-30)) {
  const [row] = await db.query<{ id: string }>(
    `insert into termination (lease_id, initiated_by, reason, notice_given_on, effective_on, notice_days)
     values ($1, 'tenant', 'early_tenant', $2, $3, 20) returning id`,
    [lease, givenOn, effectiveOn],
  );
  return row!.id;
}

/** A lease renewed once: the move-in inspection sits on the original lease. */
async function renewed() {
  const original = await leaseFor({ start: plus(-700), end: plus(-336) });
  await db.query(`update lease set status = 'terminated' where id = $1`, [original.lease]);
  await inspection(original.lease, 'incoming', plus(-700), 'completed', [['Lounge', 'Walls and paint', 'good']]);
  const current = await leaseFor({
    start: plus(-335), end: plus(30), unit: original.unit, applicant: original.applicant, previous: original.lease,
  });
  return { original, current };
}

describe('bug 1: the move-in inspection on the lease a renewal replaced', () => {
  it('backs a deduction and shows in the comparison', async () => {
    const { current } = await renewed();
    const terminationId = await termination(current.lease, plus(2));
    const outgoing = await inspection(current.lease, 'outgoing', plus(1), 'completed', [['Lounge', 'Walls and paint', 'damaged']]);

    const comparison = await call('GET', `/terminations/${terminationId}/comparison`);
    expect(comparison.status).toBe(200);
    const item = comparison.body.items.find((row: { item: string }) => row.item === 'Walls and paint');
    expect(item.incoming.condition).toBe('good');
    expect(item.deductible).toBe(true);

    const deduction = await call('POST', `/terminations/${terminationId}/deductions`, {
      body: { findingId: outgoing.findings[0], description: 'Repaint lounge', amountCents: 150000 },
    });
    expect(deduction.status).toBe(201);
  });

  it('puts the move-in condition on the settlement statement', async () => {
    const { current } = await renewed();
    const terminationId = await termination(current.lease, today());
    await inspection(current.lease, 'outgoing', plus(-1), 'completed', [['Lounge', 'Walls and paint', 'damaged']]);
    rendered.length = 0;
    const settled = await call('POST', `/terminations/${terminationId}/settle`, { body: {} });
    expect(settled.status).toBe(200);
    expect(rendered[0]!.comparisons).toEqual([
      expect.objectContaining({ room: 'Lounge', item: 'Walls and paint', incomingCondition: 'good' }),
    ]);
  });
});

describe('bug 2: rebooking the exit inspection when the end date moves', () => {
  it('replaces the stale booking instead of failing with a 500', async () => {
    const { lease } = await leaseFor({ start: plus(-300), end: plus(100) });
    const terminationId = await termination(lease, plus(10));
    const first = await call('POST', `/leases/${lease}/inspections`, { body: { kind: 'outgoing', scheduledFor: plus(9) } });
    expect(first.status).toBe(201);
    await db.query('update termination set effective_on = $2 where id = $1', [terminationId, plus(20)]);
    const second = await call('POST', `/leases/${lease}/inspections`, { body: { kind: 'outgoing', scheduledFor: plus(19) } });
    expect(second.status).toBe(201);
    const rows = await db.query<{ id: string; status: string }>(
      `select id, status from inspection where lease_id = $1 and kind = 'outgoing'`,
      [lease],
    );
    expect(Object.fromEntries(rows.map((row) => [row.id, row.status]))).toEqual({
      [first.body.id]: 'missed',
      [second.body.id]: 'in_progress',
    });
  });

  it('answers a second move-in inspection with 409, not 500', async () => {
    const { lease } = await leaseFor({ start: plus(-300), end: plus(100) });
    expect((await call('POST', `/leases/${lease}/inspections`, { body: { kind: 'incoming', scheduledFor: plus(1) } })).status).toBe(201);
    expect((await call('POST', `/leases/${lease}/inspections`, { body: { kind: 'incoming', scheduledFor: plus(2) } })).status).toBe(409);
  });

  it('does not count an exit inspection held outside the current final window at settlement', async () => {
    const { lease } = await leaseFor({ start: plus(-300), end: plus(100) });
    const terminationId = await termination(lease, today(), plus(-60));
    await inspection(lease, 'outgoing', plus(-20), 'completed');
    await db.query(
      `insert into deposit_deduction (termination_id, description, amount_cents) values ($1, 'Cleaning', 50000)`,
      [terminationId],
    );
    const settled = await call('POST', `/terminations/${terminationId}/settle`, { body: {} });
    expect(settled.status).toBe(409);
    expect(settled.body.error.message).toMatch(/No outgoing inspection/);
  });
});

describe('bug 3: a landlord cannot backdate their own notice', () => {
  it('refuses a landlord notice dated before today, and still records a tenant’s paper notice', async () => {
    // The tenant has an account: a notice the landlord records for them waits for their confirmation.
    const { lease } = await leaseFor({ start: plus(-300), end: plus(200), tenantSub: `sub-${randomUUID()}` });
    const landlord = await call('POST', `/leases/${lease}/termination`, {
      body: { initiatedBy: 'landlord', reason: 'breach_by_tenant', noticeGivenOn: plus(-10) },
    });
    expect(landlord.status).toBe(400);
    const tenantPaper = await call('POST', `/leases/${lease}/termination`, {
      body: { initiatedBy: 'tenant', reason: 'early_tenant', noticeGivenOn: plus(-10) },
    });
    expect(tenantPaper.status).toBe(201);
    expect(tenantPaper.body.noticeGivenOn).toBe(plus(-10));
  });
});

const sentTo = async (lease: string, kind: string) =>
  (await db.query<{ recipient_sub: string; channel: string; body: string }>(
    'select recipient_sub, channel, body from notification where lease_id = $1 and kind = $2',
    [lease, kind],
  ));

describe('bug 4: tenants imported without an account still get their notices', () => {
  it('notice served, deposit settled, renewal offered, ticket assigned', async () => {
    const served = await leaseFor({ start: plus(-300), end: plus(200) });
    // The landlord's own notice: one recorded for an imported tenant waits for an invite (audit 5).
    expect((await call('POST', `/leases/${served.lease}/termination`, {
      body: { initiatedBy: 'landlord', reason: 'breach_by_tenant' },
    })).status).toBe(201);
    expect((await sentTo(served.lease, 'notice_served')).map((row) => row.recipient_sub)).toContain(`applicant:${served.applicant}`);

    const settling = await leaseFor({ start: plus(-300), end: plus(200) });
    const terminationId = await termination(settling.lease, today());
    expect((await call('POST', `/terminations/${terminationId}/settle`, { body: {} })).status).toBe(200);
    expect((await sentTo(settling.lease, 'deposit_settled')).map((row) => row.recipient_sub)).toContain(`applicant:${settling.applicant}`);

    const offered = await leaseFor({ start: plus(-300), end: plus(60) });
    expect((await call('POST', `/leases/${offered.lease}/renewal`, { body: {} })).status).toBe(201);
    expect((await sentTo(offered.lease, 'renewal_offered')).map((row) => row.recipient_sub)).toContain(`applicant:${offered.applicant}`);

    const ticketed = await leaseFor({ start: plus(-300), end: plus(200) });
    const [ticket] = await db.query<{ id: string }>(
      `insert into ticket (lease_id, category, severity, title, description, target_by, created_by)
       values ($1, 'plumbing', 'routine', 'Dripping tap', 'Kitchen tap drips', now() + interval '3 days', 'sub-landlord') returning id`,
      [ticketed.lease],
    );
    expect((await call('POST', `/tickets/${ticket!.id}/actions`, {
      body: { action: 'assign', contractor: { name: 'Pipe Pro', trade: 'plumbing', phone: '+27831112222' } },
    })).status).toBe(200);
    expect((await sentTo(ticketed.lease, 'ticket_assigned')).map((row) => row.recipient_sub)).toContain(`applicant:${ticketed.applicant}`);
  });

  it('lease_signed, lease_activated and lease_ready_to_sign address them by applicant', async () => {
    const { lease, applicant } = await leaseFor({ start: plus(-300), end: plus(200) });
    const { leaseParties } = await import('../lib/recipients');
    const parties = await leaseParties(lease);
    expect(parties?.tenant?.sub).toBe(`applicant:${applicant}`);
  });
});

describe('bug 5: notices the law relies on cannot be switched off', () => {
  it('sends inspection_scheduled to a tenant who turned inspection emails off', async () => {
    const { lease, applicant } = await leaseFor({ start: plus(-10), end: plus(355), tenantSub: `sub-${randomUUID()}` });
    const [tenant] = await db.query<{ cognito_sub: string }>('select cognito_sub from applicant where id = $1', [applicant]);
    for (const category of ['inspection', 'lease', 'money']) {
      await db.query(
        `insert into notification_preference (person_sub, category, channel, enabled) values ($1, $2, 'email', false)`,
        [tenant!.cognito_sub, category],
      );
    }
    expect((await call('POST', `/leases/${lease}/inspections`, { body: { kind: 'incoming', scheduledFor: plus(1) } })).status).toBe(201);
    expect((await sentTo(lease, 'inspection_scheduled')).map((row) => row.channel)).toContain('email');

    expect((await call('POST', `/leases/${lease}/termination`, {
      sub: tenant!.cognito_sub, groups: 'tenant', body: { initiatedBy: 'tenant', reason: 'early_tenant' },
    })).status).toBe(201);
    expect((await sentTo(lease, 'notice_served')).filter((row) => row.recipient_sub === tenant!.cognito_sub).map((row) => row.channel))
      .toContain('email');

    const { TEMPLATES } = await import('../domain/notification');
    expect(TEMPLATES.deposit_settled!.category).toBe('deadline');
  });
});

describe('bug 6: lease-ending reminders inside the CPA 40 to 80 business day window', () => {
  it('sends the first reminder 80 business days out, the second 45, the last 7 calendar days', async () => {
    const far = await leaseFor({ start: plus(-250), end: plus(105) });
    const mid = await leaseFor({ start: plus(-300), end: plus(28) });
    const near = await leaseFor({ start: plus(-300), end: plus(5) });
    const tooFar = await leaseFor({ start: plus(-200), end: plus(160) });
    const { handler: sweep } = await import('../handlers/notifications-sweep');
    await sweep();
    const keys = async (lease: string) =>
      (await db.query<{ dedupe_key: string }>(
        `select dedupe_key from notification where lease_id = $1 and kind = 'lease_ending_soon'`,
        [lease],
      )).map((row) => row.dedupe_key);
    expect(await keys(far.lease)).toEqual([`lease_ending:${far.lease}:${plus(105)}:80bd:email`]);
    expect(await keys(mid.lease)).toEqual([`lease_ending:${mid.lease}:${plus(28)}:45bd:email`]);
    expect(await keys(near.lease)).toEqual([`lease_ending:${near.lease}:${plus(5)}:7d:email`]);
    expect(await keys(tooFar.lease)).toEqual([]);
  });

  it('places each business-day reminder before the 40 business day minimum', async () => {
    const { leaseEndingThreshold } = await import('../handlers/notifications-sweep');
    const { addBusinessDays } = await import('../domain/termination');
    const now = dates.dateFromIso(today());
    // A lease ending exactly 41 business days out still gets its reminder before the minimum.
    const end = dates.isoDate(addBusinessDays(now, 41));
    expect(leaseEndingThreshold(today(), end)).toBe('45bd');
    expect(leaseEndingThreshold(today(), dates.isoDate(addBusinessDays(now, 80)))).toBe('80bd');
    expect(leaseEndingThreshold(today(), dates.isoDate(addBusinessDays(now, 81)))).toBeNull();
  });
});

describe('bug 7: withdrawing a notice', () => {
  /** The month containing `iso`, invoiced in full as the run would have. */
  async function monthInvoice(lease: string, iso: string, paidCents = 0) {
    const start = `${iso.slice(0, 7)}-01`;
    const [row] = await db.query<{ id: string }>(
      `insert into invoice (lease_id, period_start, due_on, total_cents, covers_from, covers_to, status)
       values ($1, $2, $2, 700000, $2, ($2::date + interval '1 month' - interval '1 day')::date, $3) returning id`,
      [lease, start, paidCents >= 700000 ? 'paid' : 'issued'],
    );
    await db.query(
      `insert into invoice_line (invoice_id, kind, description, amount_cents) values ($1, 'rent', $2, 700000)`,
      [row!.id, `Rent · ${start.slice(0, 7)}`],
    );
    if (paidCents > 0) {
      await db.query(
        `insert into payment (lease_id, invoice_id, amount_cents, method, reference, received_on, recorded_by)
         values ($1, $2, $3, 'eft', 'rent', $4, 'sub-landlord')`,
        [lease, row!.id, paidCents, today()],
      );
    }
    return row!.id;
  }
  const invoiceState = async (ids: string[]) =>
    db.query<{ id: string; status: string; total_cents: string; covers_from: string; covers_to: string; rent: string }>(
      `select i.id, i.status, i.total_cents::text, i.covers_from::text, i.covers_to::text,
              (select sum(amount_cents) from invoice_line l where l.invoice_id = i.id and l.kind = 'rent')::text as rent
         from invoice i where i.id = any($1::uuid[]) order by i.period_start`,
      [ids],
    );

  it('lets the tenant withdraw, restores the invoices, tells the landlord, and allows a new notice', async () => {
    const tenantSub = `sub-${randomUUID()}`;
    const { lease } = await leaseFor({ start: plus(-300), end: plus(300), tenantSub });
    const served = await call('POST', `/leases/${lease}/termination`, {
      sub: tenantSub, groups: 'tenant', body: { initiatedBy: 'tenant', reason: 'early_tenant' },
    });
    expect(served.status).toBe(201);
    // Invoices raised before notice: the month the lease now ends in, and the two after.
    // Inserted after serving so the trim is applied by hand below exactly as serving would.
    const effective = served.body.effectiveOn as string;
    const ids = [
      await monthInvoice(lease, effective, 700000),
      await monthInvoice(lease, dates.nextMonthStart(effective)),
      await monthInvoice(lease, dates.nextMonthStart(dates.nextMonthStart(effective))),
    ];
    const before = await invoiceState(ids);
    const { trimInvoicesAfter } = await import('../lib/billing');
    await db.withTransaction((run) => trimInvoicesAfter(run, lease, effective));
    const trimmed = await invoiceState(ids);
    expect(trimmed.map((row) => row.status)).toContain('void');

    const withdrawn = await call('POST', `/terminations/${served.body.id}/withdraw`, { sub: tenantSub, groups: 'tenant' });
    expect(withdrawn.status).toBe(200);
    const [row] = await db.query<{ status: string }>('select status from termination where id = $1', [served.body.id]);
    expect(row!.status).toBe('withdrawn');
    expect(await invoiceState(ids)).toEqual(before);
    expect((await sentTo(lease, 'notice_withdrawn')).map((r) => r.recipient_sub)).toContain('sub-landlord');
    const audited = await db.query(
      `select 1 from audit_log where action = 'termination.withdrawn' and entity_id = $1`,
      [served.body.id],
    );
    expect(audited).toHaveLength(1);

    const again = await call('POST', `/leases/${lease}/termination`, {
      sub: tenantSub, groups: 'tenant', body: { initiatedBy: 'tenant', reason: 'early_tenant' },
    });
    expect(again.status).toBe(201);
    // The retention rule reads one row per lease, with the live notice's date.
    const { leasesOf } = await import('../lib/privacy');
    const leases = await leasesOf(tenantSub);
    expect(leases).toHaveLength(1);
    expect(leases[0]!.terminationEffectiveOn).toBe(again.body.effectiveOn);
  });

  it('restores invoices the serve endpoint trimmed', async () => {
    const { lease } = await leaseFor({ start: plus(-300), end: plus(300) });
    const ids = [await monthInvoice(lease, plus(40)), await monthInvoice(lease, dates.nextMonthStart(plus(40)))];
    const before = await invoiceState(ids);
    // The landlord's own notice: only the party who gave a notice withdraws it.
    const served = await call('POST', `/leases/${lease}/termination`, {
      body: { initiatedBy: 'landlord', reason: 'breach_by_tenant' },
    });
    expect(served.status).toBe(201);
    expect(served.body.invoicesAdjusted).toBeGreaterThan(0);
    const withdrawn = await call('POST', `/terminations/${served.body.id}/withdraw`);
    expect(withdrawn.status).toBe(200);
    expect(await invoiceState(ids)).toEqual(before);
    expect((await sentTo(lease, 'notice_withdrawn')).map((r) => r.recipient_sub)).toContain(
      (await db.query<{ s: string }>(`select 'applicant:' || applicant_id as s from lease where id = $1`, [lease]))[0]!.s,
    );
  });

  it('is refused once the end date has arrived, after settlement, and for a stranger', async () => {
    const { lease } = await leaseFor({ start: plus(-300), end: plus(300) });
    const ended = await termination(lease, today());
    // The landlord's own notice, so the landlord is the one who may withdraw it.
    await db.query(`update termination set initiated_by = 'landlord', reason = 'breach_by_tenant' where id = $1`, [ended]);
    expect((await call('POST', `/terminations/${ended}/withdraw`)).status).toBe(409);
    await db.query(`update termination set status = 'settled', effective_on = $2 where id = $1`, [ended, plus(5)]);
    expect((await call('POST', `/terminations/${ended}/withdraw`)).status).toBe(409);
    await db.query(`update termination set status = 'notice_served' where id = $1`, [ended]);
    expect((await call('POST', `/terminations/${ended}/withdraw`, { sub: 'sub-stranger', groups: 'tenant' })).status).toBe(403);
  });

  it('refuses a second deduction for the same finding', async () => {
    const { lease } = await leaseFor({ start: plus(-300), end: plus(300) });
    await inspection(lease, 'incoming', plus(-300), 'completed', [['Kitchen', 'Sink and taps', 'good']]);
    const terminationId = await termination(lease, plus(2));
    const outgoing = await inspection(lease, 'outgoing', plus(1), 'completed', [['Kitchen', 'Sink and taps', 'missing']]);
    const body = { findingId: outgoing.findings[0], description: 'Replace tap', amountCents: 90000 };
    expect((await call('POST', `/terminations/${terminationId}/deductions`, { body })).status).toBe(201);
    expect((await call('POST', `/terminations/${terminationId}/deductions`, { body })).status).toBe(409);
    await expect(
      db.query(
        `insert into deposit_deduction (termination_id, finding_id, description, amount_cents) values ($1, $2, 'again', 1)`,
        [terminationId, outgoing.findings[0]],
      ),
    ).rejects.toThrow();
  });
});

describe('bug 8: the rent credit refunded at settlement leaves the books', () => {
  it('brings the rent statement to zero', async () => {
    const { lease } = await leaseFor({ start: plus(-300), end: plus(300) });
    const terminationId = await termination(lease, plus(-2));
    const [invoice] = await db.query<{ id: string }>(
      `insert into invoice (lease_id, period_start, due_on, total_cents, status)
       values ($1, $2::date - 30, $2::date - 30, 400000, 'paid') returning id`,
      [lease, today()],
    );
    await db.query(
      `insert into payment (lease_id, invoice_id, amount_cents, method, reference, received_on, recorded_by)
       values ($1, $2, 900000, 'eft', 'rent', $3::date - 31, 'sub-landlord')`,
      [lease, invoice!.id, today()],
    );
    const settled = await call('POST', `/terminations/${terminationId}/settle`, { body: {} });
    expect(settled.status).toBe(200);
    expect(settled.body.rentCreditCents).toBe(500000);
    const statement = await call('GET', `/leases/${lease}/statement`);
    expect(statement.body.balanceCents).toBe(0);
  });
});

describe('bug 9: a ticket left at done', () => {
  async function doneTicket(daysAgo: number) {
    const { lease } = await leaseFor({ start: plus(-300), end: plus(300) });
    const [ticket] = await db.query<{ id: string }>(
      `insert into ticket (lease_id, category, severity, title, description, status, target_by, created_by, completed_at)
       values ($1, 'plumbing', 'routine', 'Leak', 'Under the sink', 'done', now(), 'sub-landlord',
               now() - make_interval(days => $2::int)) returning id`,
      [lease, daysAgo],
    );
    return ticket!.id;
  }

  it('lets the landlord close it after 7 days without a rating', async () => {
    const id = await doneTicket(8);
    const closed = await call('POST', `/tickets/${id}/close`, { body: {} });
    expect(closed.status).toBe(200);
    const [row] = await db.query<{ status: string; rating: number | null }>('select status, rating from ticket where id = $1', [id]);
    expect(row).toEqual({ status: 'closed', rating: null });
  });

  it('does not let the landlord close it sooner', async () => {
    const id = await doneTicket(2);
    expect((await call('POST', `/tickets/${id}/close`, { body: {} })).status).toBe(403);
  });
});

describe('bug 10: deadlines in messages are South African time', () => {
  const sast = (instant: string | Date) =>
    new Date(new Date(instant).getTime() + 2 * 3600000).toISOString().slice(0, 16).replace('T', ' ');

  it('prints the ticket target in SAST', async () => {
    const { lease } = await leaseFor({ start: plus(-300), end: plus(300) });
    const created = await call('POST', `/leases/${lease}/tickets`, {
      body: { category: 'plumbing', severity: 'urgent', title: 'Burst pipe', description: 'Water everywhere' },
    });
    expect(created.status).toBe(201);
    const [message] = await sentTo(lease, 'ticket_raised');
    expect(message!.body).toContain(sast(created.body.targetBy));
  });

  it('prints the SLA warning target in SAST', async () => {
    const { lease } = await leaseFor({ start: plus(-300), end: plus(300) });
    const [ticket] = await db.query<{ target_by: Date }>(
      `insert into ticket (lease_id, category, severity, title, description, target_by, created_by)
       values ($1, 'plumbing', 'urgent', 'No water', 'None at all', now() + interval '2 hours', 'sub-landlord')
       returning target_by`,
      [lease],
    );
    const { slaSweep } = await import('../handlers/notifications-sweep');
    await slaSweep();
    const [message] = await sentTo(lease, 'sla_breach_soon');
    expect(message!.body).toContain(sast(ticket!.target_by));
  });
});

describe('follow-up: the settlement preview', () => {
  it('shows the exact refund the settlement then pays, and only to the landlord', async () => {
    const tenantSub = `sub-${randomUUID()}`;
    const { lease } = await leaseFor({ start: plus(-300), end: plus(300), tenantSub });
    const terminationId = await termination(lease, plus(-2));
    await db.query(
      `insert into deposit_ledger (lease_id, entry_type, amount_cents, note) values ($1, 'received', 700000, 'Deposit')`,
      [lease],
    );
    await db.query(
      `insert into invoice (lease_id, period_start, due_on, total_cents, status)
       values ($1, $2::date - 20, $2::date - 20, 100000, 'issued')`,
      [lease, today()],
    );

    const preview = await call('GET', `/terminations/${terminationId}/settlement`);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      heldCents: 700000, arrearsCents: 100000, deductionsCents: 0, refundCents: 600000, tenantOwesCents: 0, blocker: null,
    });
    expect((await call('GET', `/terminations/${terminationId}/settlement`, { sub: tenantSub, groups: 'tenant' })).status).toBe(403);

    const settled = await call('POST', `/terminations/${terminationId}/settle`, { body: {} });
    expect(settled.status).toBe(200);
    expect(settled.body.refundCents).toBe(preview.body.refundCents);
    expect(settled.body.refundDueBy).toBe(preview.body.refundDueBy);
  });

  it('says when the lease has not ended yet', async () => {
    const { lease } = await leaseFor({ start: plus(-300), end: plus(300) });
    const terminationId = await termination(lease, plus(10));
    const preview = await call('GET', `/terminations/${terminationId}/settlement`);
    expect(preview.status).toBe(200);
    expect(preview.body.blocker).toMatch(/The lease runs until/);
  });

  it('names what blocks the settlement instead of failing', async () => {
    const { lease } = await leaseFor({ start: plus(-300), end: plus(300) });
    const terminationId = await termination(lease, plus(-2));
    await db.query(
      `insert into deposit_deduction (termination_id, description, amount_cents) values ($1, 'Carpet', 50000)`,
      [terminationId],
    );
    const preview = await call('GET', `/terminations/${terminationId}/settlement`);
    expect(preview.status).toBe(200);
    expect(preview.body.blocker).toMatch(/No outgoing inspection/);
    expect((await call('POST', `/terminations/${terminationId}/settle`, { body: {} })).status).toBe(409);
  });
});

describe('follow-up: tenancy import limits', () => {
  const LANDLORD = '11111111-1111-1111-1111-111111111111';
  const row = (unit: string) => ({
    property: 'Kruis Court', unit, firstName: 'Lerato', lastName: 'Import', email: `${unit.toLowerCase()}@example.co.za`,
    phone: '+27821112222', startDate: plus(-200), endDate: plus(165), monthlyRentCents: 600000,
    escalationPct: 0, depositHeldCents: 0, currentMonthPaid: true, arrearsCents: 0, bedrooms: 1, bathrooms: 1,
  });

  it('caps imports per account per hour, previews included', async () => {
    const { importsByLandlord } = await import('../lib/ratelimit');
    try {
      for (let i = 0; i < 30; i += 1) {
        expect((await call('POST', '/leases/import', { body: { rows: [row('ZQ1')], dryRun: true } })).status).toBe(200);
      }
      expect((await call('POST', '/leases/import', { body: { rows: [row('ZQ1')], dryRun: true } })).status).toBe(429);
    } finally {
      importsByLandlord.clear(LANDLORD);
    }
  });

  it('refuses an import whose invitations would pass the daily budget, and writes nothing', async () => {
    const { importInvitesByLandlord } = await import('../lib/ratelimit');
    try {
      for (let i = 0; i < 499; i += 1) importInvitesByLandlord.record(LANDLORD);
      const refused = await call('POST', '/leases/import', {
        body: { rows: [row('ZQ2'), row('ZQ3')], dryRun: false, invite: true },
      });
      expect(refused.status).toBe(429);
      expect(JSON.stringify(refused.body)).toMatch(/send 1 more invitation today/);
      expect(await db.query(`select 1 from unit where code in ('ZQ2', 'ZQ3')`)).toHaveLength(0);
      const without = await call('POST', '/leases/import', { body: { rows: [row('ZQ2'), row('ZQ3')], dryRun: false } });
      expect(without.status).toBe(201);
    } finally {
      importInvitesByLandlord.clear(LANDLORD);
    }
  });
});

describe('follow-up: withdrawing a notice brings the renewal back', () => {
  it('re-opens an offer the notice lapsed', async () => {
    const tenantSub = `sub-${randomUUID()}`;
    const { lease } = await leaseFor({ start: plus(-300), end: plus(120), tenantSub });
    const [offer] = await db.query<{ id: string }>(
      `insert into renewal (lease_id, respond_by, term_months, new_start_date, new_end_date, new_rent_cents)
       values ($1, $2, 12, $3, $4, 750000) returning id`,
      [lease, plus(60), plus(121), plus(486)],
    );
    const served = await call('POST', `/leases/${lease}/termination`, {
      sub: tenantSub, groups: 'tenant', body: { initiatedBy: 'tenant', reason: 'early_tenant' },
    });
    expect(served.status).toBe(201);
    const status = async () => (await db.query<{ status: string }>('select status from renewal where id = $1', [offer!.id]))[0]!.status;
    expect(await status()).toBe('lapsed');

    const withdrawn = await call('POST', `/terminations/${served.body.id}/withdraw`, { sub: tenantSub, groups: 'tenant' });
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.renewalsRestored).toBe(1);
    expect(await status()).toBe('offered');
  });

  it('puts back an accepted, unsigned renewal and its scheduled lease', async () => {
    const tenantSub = `sub-${randomUUID()}`;
    const current = await leaseFor({ start: plus(-300), end: plus(120), tenantSub });
    const next = await leaseFor({
      start: plus(121), end: plus(486), unit: current.unit, applicant: current.applicant, previous: current.lease,
      status: 'scheduled',
    });
    const [renewal] = await db.query<{ id: string }>(
      `insert into renewal (lease_id, respond_by, term_months, new_start_date, new_end_date, new_rent_cents, status, new_lease_id)
       values ($1, $2, 12, $3, $4, 750000, 'accepted', $5) returning id`,
      [current.lease, plus(60), plus(121), plus(486), next.lease],
    );
    const served = await call('POST', `/leases/${current.lease}/termination`, {
      sub: tenantSub, groups: 'tenant', body: { initiatedBy: 'tenant', reason: 'early_tenant' },
    });
    expect(served.status).toBe(201);
    expect(served.body.renewalCancelled).toBe(next.lease);

    const withdrawn = await call('POST', `/terminations/${served.body.id}/withdraw`, { sub: tenantSub, groups: 'tenant' });
    expect(withdrawn.status).toBe(200);
    const [lease] = await db.query<{ status: string }>('select status from lease where id = $1', [next.lease]);
    const [after] = await db.query<{ status: string }>('select status from renewal where id = $1', [renewal!.id]);
    expect(lease!.status).toBe('scheduled');
    expect(after!.status).toBe('accepted');
  });

  it('leaves an offer lapsed once its reply date has passed', async () => {
    const tenantSub = `sub-${randomUUID()}`;
    const { lease } = await leaseFor({ start: plus(-300), end: plus(120), tenantSub });
    const [offer] = await db.query<{ id: string }>(
      `insert into renewal (lease_id, respond_by, term_months, new_start_date, new_end_date, new_rent_cents)
       values ($1, $2, 12, $3, $4, 750000) returning id`,
      [lease, plus(60), plus(121), plus(486)],
    );
    const served = await call('POST', `/leases/${lease}/termination`, {
      sub: tenantSub, groups: 'tenant', body: { initiatedBy: 'tenant', reason: 'early_tenant' },
    });
    await db.query(`update renewal set respond_by = $2 where id = $1`, [offer!.id, plus(-1)]);
    const withdrawn = await call('POST', `/terminations/${served.body.id}/withdraw`, { sub: tenantSub, groups: 'tenant' });
    expect(withdrawn.body.renewalsRestored).toBe(0);
    const [row] = await db.query<{ status: string }>('select status from renewal where id = $1', [offer!.id]);
    expect(row!.status).toBe('lapsed');
  });
});
