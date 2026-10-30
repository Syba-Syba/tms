import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const LEASE = '66666666-6666-6666-6666-666666666666';
const PROPERTY = '22222222-2222-2222-2222-222222222222';

/** Workflow fixes: exit inspections on holdover leases, the morning sweep, renewals and notice,
    landlord end-of-term notice, interest catch-up, quiet hours, credit check dates, withdrawal. */
type Opts = { sub?: string; groups?: string; body?: unknown };
let call: (method: string, path: string, opts?: Opts) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let dates: typeof import('../domain/dates');

const tenant: Opts = { sub: 'sub-tenant', groups: 'tenant' };

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://workflows-audit-2-${Date.now()}`;
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

/** A unit with an active lease held by an imported tenant who never accepted the invite. */
async function leaseFor(opts: { start: string; end: string; applicant?: string }) {
  const unit = randomUUID();
  const applicant = opts.applicant ?? randomUUID();
  const application = randomUUID();
  const lease = randomUUID();
  await db.query(
    `insert into unit (id, property_id, code, bedrooms, bathrooms, monthly_rent_cents, deposit_cents, status)
     values ($1, $2, $3, 1, 1, 700000, 700000, 'occupied')`,
    [unit, PROPERTY, `X${unit.slice(0, 4)}`],
  );
  if (!opts.applicant) await db.query(
    `insert into applicant (id, cognito_sub, first_name, last_name, id_number_enc, id_number_last4,
                            email, phone, employment_status, monthly_income_cents)
     values ($1, null, 'Imported', 'Tenant', '\\x00', '0001', $2, '+27820000000', 'employed', 2000000)`,
    [applicant, `t-${applicant.slice(0, 6)}@example.co.za`],
  );
  await db.query(
    `insert into application (id, unit_id, applicant_id, status, preferred_move_in)
     values ($1, $2, $3, 'approved', $4)`,
    [application, unit, applicant, opts.start],
  );
  await db.query(
    `insert into lease (id, application_id, unit_id, applicant_id, start_date, end_date,
                        monthly_rent_cents, escalation_pct, deposit_cents, status)
     values ($1, $2, $3, $4, $5, $6, 700000, 0, 700000, 'active')`,
    [lease, application, unit, applicant, opts.start, opts.end],
  );
  return { unit, applicant, application, lease };
}

describe('bug 1: the exit inspection on a lease running month to month', () => {
  it('opens the window on the notice date, not on the end date that has passed', async () => {
    const { lease } = await leaseFor({ start: plus(-400), end: plus(-30) });
    await db.query(
      `insert into termination (lease_id, initiated_by, reason, notice_given_on, effective_on, notice_days)
       values ($1, 'tenant', 'end_of_term', $2, $3, 20)`,
      [lease, plus(-26), plus(2)],
    );
    const created = await call('POST', `/leases/${lease}/inspections`, {
      body: { kind: 'outgoing', scheduledFor: plus(1) },
    });
    expect(created.status).toBe(201);
  });
});

describe('bug 2 and 7: the morning sweep', () => {
  let held: Awaited<ReturnType<typeof leaseFor>>;

  it('reminds an imported tenant without an account of tomorrow’s inspection', async () => {
    held = await leaseFor({ start: plus(-100), end: plus(200) });
    await db.query(
      `insert into inspection (lease_id, kind, scheduled_for) values ($1, 'incoming', $2)`,
      [held.lease, plus(1)],
    );
    const { handler: sweep } = await import('../handlers/notifications-sweep');
    await sweep();
    const rows = await db.query<{ recipient_sub: string }>(
      `select recipient_sub from notification where lease_id = $1 and kind = 'inspection_tomorrow'`,
      [held.lease],
    );
    expect(rows.map((row) => row.recipient_sub)).toContain(`applicant:${held.applicant}`);
  });

  it('still lapses renewals when one step fails, and reports the failure', async () => {
    const other = await leaseFor({ start: plus(-100), end: plus(200) });
    await db.query(
      `insert into inspection (lease_id, kind, scheduled_for) values ($1, 'incoming', $2)`,
      [other.lease, plus(1)],
    );
    const [renewal] = await db.query<{ id: string }>(
      `insert into renewal (lease_id, offered_on, respond_by, term_months, new_start_date, new_end_date, new_rent_cents)
       values ($1, $2, $3, 12, $4, $5, 750000) returning id`,
      [other.lease, plus(-20), plus(-1), plus(200), plus(565)],
    );
    // Any failure while writing an inspection reminder stands in for a bad row.
    await db.query(
      `alter table notification add constraint test_block check (kind <> 'inspection_tomorrow') not valid`,
    );
    try {
      const { handler: sweep } = await import('../handlers/notifications-sweep');
      await expect(sweep()).rejects.toThrow(/failed/);
    } finally {
      await db.query('alter table notification drop constraint test_block');
    }
    const [after] = await db.query<{ status: string }>('select status from renewal where id = $1', [renewal!.id]);
    expect(after!.status).toBe('lapsed');
  });

  it('sends a lease-ending reminder missed on its exact day, once', async () => {
    const ending = await leaseFor({ start: plus(-300), end: plus(28) });
    const { handler: sweep } = await import('../handlers/notifications-sweep');
    await sweep();
    await sweep();
    const rows = await db.query<{ dedupe_key: string }>(
      `select dedupe_key from notification where lease_id = $1 and kind = 'lease_ending_soon'`,
      [ending.lease],
    );
    expect(rows.map((row) => row.dedupe_key)).toEqual([`lease_ending:${ending.lease}:${plus(28)}:30:email`]);
  });

  it('reminds of an inspection today when yesterday’s sweep did not run', async () => {
    const late = await leaseFor({ start: plus(-100), end: plus(200) });
    await db.query(`insert into inspection (lease_id, kind, scheduled_for) values ($1, 'incoming', $2)`, [late.lease, today()]);
    const { handler: sweep } = await import('../handlers/notifications-sweep');
    await sweep();
    const rows = await db.query(
      `select id from notification where lease_id = $1 and kind = 'inspection_tomorrow'`,
      [late.lease],
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('bug 6: maintenance deadline warnings', () => {
  it('are raised by the frequent dispatch run, once per deadline', async () => {
    const [ticket] = await db.query<{ id: string }>(
      `insert into ticket (lease_id, category, severity, title, description, target_by, created_by)
       values ($1, 'plumbing', 'urgent', 'Geyser leaking', 'Water through the ceiling', now() + interval '2 hours', 'sub-tenant')
       returning id`,
      [LEASE],
    );
    const { handler: dispatch } = await import('../handlers/notifications-dispatch');
    await dispatch();
    await dispatch();
    const rows = await db.query(
      `select id from notification where kind = 'sla_breach_soon' and body like '%Geyser leaking%'`,
    );
    expect(rows).toHaveLength(1);
    expect(ticket).toBeDefined();
  });
});

describe('bug 3: an accepted renewal that is not yet signed', () => {
  const offerAndAccept = async (lease: string) => {
    const offer = await call('POST', `/leases/${lease}/renewal`, { body: {} });
    expect(offer.status).toBe(201);
    return call('POST', `/renewals/${offer.body.id}/decision`, { ...tenant, body: { decision: 'accept' } });
  };
  let second: string;

  it('is replaced by a second offer instead of failing on acceptance', async () => {
    const first = await offerAndAccept(LEASE);
    expect(first.status).toBe(200);
    const again = await offerAndAccept(LEASE);
    expect(again.status).toBe(200);
    second = again.body.newLeaseId;
    const rows = await db.query<{ id: string; status: string }>(
      `select id, status from lease where previous_lease_id = $1`,
      [LEASE],
    );
    expect(Object.fromEntries(rows.map((row) => [row.id, row.status]))).toEqual({
      [first.body.newLeaseId]: 'cancelled',
      [second]: 'scheduled',
    });
  });

  it('blocks a new offer and notice once both parties have signed it', async () => {
    for (const party of ['tenant', 'landlord']) {
      await db.query(
        `insert into lease_signature (lease_id, party, signature_s3_key, pdf_sha256) values ($1, $2, 'k', 'h')`,
        [second, party],
      );
    }
    expect((await call('POST', `/leases/${LEASE}/renewal`, { body: {} })).status).toBe(409);
    const notice = await call('POST', `/leases/${LEASE}/termination`, {
      body: { initiatedBy: 'landlord', reason: 'end_of_term' },
    });
    expect(notice.status).toBe(409);
    await db.query('delete from lease_signature where lease_id = $1', [second]);
  });

  it('is cancelled when notice is served', async () => {
    const notice = await call('POST', `/leases/${LEASE}/termination`, {
      body: { initiatedBy: 'landlord', reason: 'end_of_term' },
    });
    expect(notice.status).toBe(201);
    const [lease] = await db.query<{ status: string }>('select status from lease where id = $1', [second]);
    expect(lease!.status).toBe('cancelled');
    const [renewal] = await db.query<{ status: string }>('select status from renewal where new_lease_id = $1', [second]);
    expect(renewal!.status).toBe('lapsed');
  });

  it('answers a clash with another scheduled lease with 409, not 500', async () => {
    const other = await leaseFor({ start: plus(-300), end: plus(150), applicant: '44444444-4444-4444-4444-444444444444' });
    const offer = await call('POST', `/leases/${other.lease}/renewal`, { body: {} });
    expect(offer.status).toBe(201);
    await db.query(
      `insert into lease (application_id, unit_id, applicant_id, start_date, end_date,
                          monthly_rent_cents, escalation_pct, deposit_cents, status)
       values ($1, $2, $3, $4, $5, 700000, 0, 700000, 'scheduled')`,
      [other.application, other.unit, other.applicant, plus(151), plus(500)],
    );
    const accepted = await call('POST', `/renewals/${offer.body.id}/decision`, { ...tenant, body: { decision: 'accept' } });
    expect(accepted.status).toBe(409);
  });
});

describe('bug 4: a landlord ending a fixed term', () => {
  it('needs 20 business days when served fewer than 40 before the end date', async () => {
    const t = await import('../domain/termination');
    const notice = new Date('2026-11-02T00:00:00Z');
    const end = new Date('2026-11-10T00:00:00Z');
    const twenty = t.addBusinessDays(notice, 20);
    expect(t.earliestEffectiveDate('end_of_term', notice, end, 'landlord')).toEqual(twenty);
    expect(t.noticeBusinessDays('end_of_term', notice, end, 'landlord')).toBe(20);
    expect(t.latestEffectiveDate('end_of_term', notice, end, 'landlord') >= twenty).toBe(true);
    // The tenant's rule is unchanged, and a landlord in good time ends it on the end date.
    expect(t.earliestEffectiveDate('end_of_term', notice, end, 'tenant')).toEqual(end);
    expect(t.earliestEffectiveDate('end_of_term', new Date('2026-06-01T00:00:00Z'), end, 'landlord')).toEqual(end);
  });

  it('refuses a landlord notice ending the lease on its end date ten days away', async () => {
    const short = await leaseFor({ start: plus(-300), end: plus(10) });
    const notice = await call('POST', `/leases/${short.lease}/termination`, {
      body: { initiatedBy: 'landlord', reason: 'end_of_term', effectiveOn: plus(10) },
    });
    expect(notice.status).toBe(400);
    const lawful = await call('POST', `/leases/${short.lease}/termination`, {
      body: { initiatedBy: 'landlord', reason: 'end_of_term' },
    });
    expect(lawful.status).toBe(201);
    expect(lawful.body.effectiveOn > plus(10)).toBe(true);
  });
});

describe('bug 3 follow-up: charges past the new last month', () => {
  it('move onto the last invoice when notice is served', async () => {
    const ending = await leaseFor({ start: plus(-300), end: plus(10) });
    const month = dates.sastMonthStart();
    const later = dates.nextMonthStart(dates.nextMonthStart(dates.nextMonthStart(month)));
    await db.query(
      `insert into invoice (lease_id, period_start, due_on, total_cents) values ($1, $2, $2, 700000)`,
      [ending.lease, month],
    );
    await db.query(
      `insert into pending_charge (lease_id, period_start, kind, description, amount_cents, added_by)
       values ($1, $2, 'utility', 'Water', 45000, 'sub-landlord')`,
      [ending.lease, later],
    );
    const notice = await call('POST', `/leases/${ending.lease}/termination`, {
      body: { initiatedBy: 'landlord', reason: 'end_of_term' },
    });
    expect(notice.status).toBe(201);
    expect(await db.query('select id from pending_charge where lease_id = $1', [ending.lease])).toHaveLength(0);
    const lines = await db.query<{ amount_cents: string }>(
      `select l.amount_cents::text from invoice_line l join invoice i on i.id = l.invoice_id
        where i.lease_id = $1 and l.description like 'Water%'`,
      [ending.lease],
    );
    expect(lines).toEqual([{ amount_cents: '45000' }]);
  });
});

describe('bug 5: deposit interest catches up later in the month', () => {
  it('is scheduled daily, and a run on the 3rd posts the month on deposits held at its start', async () => {
    const { JOBS } = await import('../lib/scheduler');
    expect(JOBS.find((job) => job.name === 'interest-run')?.onDay).toBeUndefined();

    const early = await leaseFor({ start: '2026-01-01', end: '2027-06-30' });
    const late = await leaseFor({ start: '2026-01-01', end: '2027-06-30' });
    await db.query(
      `insert into deposit_ledger (lease_id, entry_type, amount_cents, occurred_on) values ($1, 'received', 700000, '2027-02-20')`,
      [early.lease],
    );
    await db.query(
      `insert into deposit_ledger (lease_id, entry_type, amount_cents, occurred_on) values ($1, 'received', 700000, '2027-03-02')`,
      [late.lease],
    );
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-03-03T04:00:00Z'));
    const { handler: interest } = await import('../handlers/interest-run');
    await interest();
    const rows = await db.query<{ lease_id: string; period_month: string }>(
      `select lease_id, period_month::text from deposit_ledger
        where entry_type = 'interest' and lease_id = any($1::uuid[])`,
      [[early.lease, late.lease]],
    );
    expect(rows).toEqual([{ lease_id: early.lease, period_month: '2027-03-01' }]);
  });
});

describe('bug 8: quiet hours', () => {
  it('holds a message raised at 00:30 SAST until 07:00 that morning', async () => {
    const { sendAfter } = await import('../domain/notification');
    expect(sendAfter(new Date('2026-10-29T22:30:00Z'), false).toISOString()).toBe('2026-10-30T05:00:00.000Z');
    expect(sendAfter(new Date('2026-10-29T19:00:00Z'), false).toISOString()).toBe('2026-10-30T05:00:00.000Z');
  });
});

describe('bug 9 and 10: applications', () => {
  let application: string;

  it('accepts a credit check dated today in South Africa just after midnight', async () => {
    const [row] = await db.query<{ id: string }>(
      `select id from application where applicant_id = '44444444-4444-4444-4444-444444444445'`,
    );
    application = row!.id;
    await db.query(
      `insert into consent (person_sub, kind, version, subject_id) values ('sub-applicant', 'credit_check', 'x', $1)`,
      [application],
    );
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-29T23:00:00Z'));
    const recorded = await call('POST', `/applications/${application}/credit-check`, {
      body: {
        bureau: 'tpn', checkedOn: '2026-10-30', score: 650, outcome: 'clear',
        judgements: 0, defaults: 0, notes: null, reportKey: null,
      },
    });
    expect(recorded.status).toBe(200);
  });

  it('tells the applicant when the landlord withdraws, and closes the lease’s inspections', async () => {
    await db.query(`update application set status = 'approved' where id = $1`, [application]);
    const [lease] = await db.query<{ id: string }>(
      `insert into lease (application_id, unit_id, applicant_id, start_date, end_date,
                          monthly_rent_cents, escalation_pct, deposit_cents, status)
       select id, unit_id, applicant_id, $2, $3, 620000, 0, 620000, 'out_for_signature'
         from application where id = $1 returning id`,
      [application, plus(10), plus(375)],
    );
    await db.query(
      `insert into lease_signature (lease_id, party, signature_s3_key, pdf_sha256) values ($1, 'tenant', 'k', 'h')`,
      [lease!.id],
    );
    const [inspection] = await db.query<{ id: string }>(
      `insert into inspection (lease_id, kind, scheduled_for) values ($1, 'incoming', $2) returning id`,
      [lease!.id, plus(10)],
    );
    const withdrawn = await call('POST', `/applications/${application}/withdraw`);
    expect(withdrawn.status).toBe(200);
    const [closed] = await db.query<{ status: string }>('select status from inspection where id = $1', [inspection!.id]);
    expect(closed!.status).not.toMatch(/in_progress|awaiting_signatures/);
    const told = await db.query<{ recipient_sub: string }>(
      `select recipient_sub from notification where kind = 'application_withdrawn'`,
    );
    expect(told.map((row) => row.recipient_sub)).toContain('sub-applicant');
  });
});
