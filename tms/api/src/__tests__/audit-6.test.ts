import { beforeAll, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const PROPERTY = '22222222-2222-2222-2222-222222222222';
const LANDLORD_ID = '11111111-1111-1111-1111-111111111111';

/** Sixth audit: an unconfirmed notice is not in force and can be attested with the tenant's
    written notice; payments can be reversed and the refund recorded as paid; settlement
    shortfalls fall due today; plus the smaller money and list fixes. */
type Opts = { sub?: string; groups?: string; body?: unknown; query?: Record<string, string> };
let call: (method: string, path: string, opts?: Opts) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let dates: typeof import('../domain/dates');

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://audit-6-${Date.now()}`;
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


/** A lease that ended two days ago with its exit inspection done, ready to settle. */
async function settleable(opts: { tenantSub?: string; depositCents?: number; previous?: string; unit?: string; applicant?: string } = {}) {
  const ids = await leaseFor({ start: plus(-300), end: plus(100), ...opts });
  await inspection(ids.lease, 'incoming', plus(-300), 'completed', [['Lounge', 'Walls', 'good']]);
  const terminationId = await termination(ids.lease, plus(-2));
  await inspection(ids.lease, 'outgoing', plus(-3), 'completed', [['Lounge', 'Walls', 'damaged']]);
  await deposit(ids.lease, opts.depositCents ?? 700000);
  return { ...ids, terminationId };
}

const deduct = (terminationId: string, description: string, cents: number) =>
  db.query(`insert into deposit_deduction (termination_id, description, amount_cents) values ($1, $2, $3)`,
    [terminationId, description, cents]);

/** Runs `during` while the statement PDF is being stored: the window between the figures being
    read and the settle transaction starting. */
async function duringRender(during: () => Promise<unknown>, fn: () => Promise<unknown>) {
  const { storage } = await import('../lib/storage');
  const store = storage();
  const put = store.put.bind(store);
  let ran = false;
  store.put = async (...args: Parameters<typeof put>) => {
    if (!ran) { ran = true; await during(); }
    return put(...args);
  };
  try { return await fn(); } finally { store.put = put; }
}


const monthStart = (iso: string) => `${iso.slice(0, 7)}-01`;
const addMonths = (iso: string, n: number) => {
  const d = new Date(`${monthStart(iso)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};

async function invoice(lease: string, period: string, cents = 700000, opts: { dueOn?: string; status?: string } = {}) {
  const [row] = await db.query<{ id: string }>(
    `insert into invoice (lease_id, period_start, due_on, total_cents, status) values ($1, $2, $3, $4, $5) returning id`,
    [lease, period, opts.dueOn ?? period, cents, opts.status ?? 'issued'],
  );
  await db.query(`insert into invoice_line (invoice_id, kind, description, amount_cents) values ($1, 'rent', 'Rent', $2)`, [row!.id, cents]);
  return row!.id;
}

async function pay(lease: string, invoiceId: string, cents: number, on = today()) {
  const [row] = await db.query<{ id: string }>(
    `insert into payment (lease_id, invoice_id, amount_cents, method, reference, received_on, recorded_by)
     values ($1, $2, $3, 'eft', 'RENT', $4, 'sub-landlord') returning id`,
    [lease, invoiceId, cents, on],
  );
  return row!.id;
}

const invoiceRow = async (id: string) =>
  (await db.query<{ status: string; total_cents: string; due_on: string }>(
    'select status, total_cents::text, due_on::text from invoice where id = $1', [id]))[0]!;

/** A notice the landlord recorded for the tenant, not yet confirmed. */
async function awaitingNotice(lease: string, effectiveOn: string, opts: { initiatedBy?: string; recordedDaysAgo?: number } = {}) {
  const id = await termination(lease, effectiveOn, opts.initiatedBy ?? 'tenant', plus(-(opts.recordedDaysAgo ?? 0) - 1));
  await db.query(
    `update termination set needs_tenant_confirmation = true, created_at = now() - make_interval(days => $2::int) where id = $1`,
    [id, opts.recordedDaysAgo ?? 0],
  );
  return id;
}

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

/** Uploads a written notice for a lease the way the app does and returns its evidence key. */
async function evidenceFor(lease: string, opts: Opts = {}) {
  const link = await call('POST', `/leases/${lease}/notice-evidence/presign`, {
    ...opts, body: { contentType: 'application/pdf', sizeBytes: PDF.length },
  });
  expect(link.status).toBe(201);
  const { storage } = await import('../lib/storage');
  await storage().put(link.body.evidenceKey, PDF, 'application/pdf');
  return link.body.evidenceKey as string;
}

const STATEMENT = 'The tenant emailed this notice to me and I have attached it unaltered.';

describe('money 1: a settlement shortfall is not born overdue', () => {
  it('falls due today when it lands on an old invoice that was fully paid', async () => {
    const ids = await settleable({ depositCents: 100000 });
    const old = await invoice(ids.lease, addMonths(today(), -3), 700000, { status: 'paid' });
    await pay(ids.lease, old, 700000, addMonths(today(), -3));
    await deduct(ids.terminationId, 'Carpet replaced', 300000);
    const settled = await call('POST', `/terminations/${ids.terminationId}/settle`, { body: {} });
    expect(settled.status).toBe(200);
    expect(settled.body.tenantOwesCents).toBe(200000);
    const row = await invoiceRow(old);
    expect(row).toMatchObject({ status: 'part_paid', total_cents: '900000' });
    expect(row.due_on).toBe(today());
  });
});

describe('money 2: a landlord-recorded notice the tenant has not confirmed', () => {
  it('is not in force: nothing is trimmed, offers stand, and rent is still billed, until the tenant confirms', async () => {
    const tenantSub = `sub-${randomUUID()}`;
    const { lease } = await leaseFor({ start: plus(-100), end: plus(265), tenantSub });
    const later = await invoice(lease, addMonths(today(), 3));
    await db.query(
      `insert into renewal (lease_id, respond_by, term_months, new_start_date, new_end_date, new_rent_cents)
       values ($1, $2, 12, $3, $4, 700000)`,
      [lease, plus(10), plus(266), plus(630)],
    );
    const served = await call('POST', `/leases/${lease}/termination`, { body: { initiatedBy: 'tenant', reason: 'early_tenant' } });
    expect(served.status).toBe(201);
    expect(served.body).toMatchObject({ awaitingTenant: true, invoicesAdjusted: 0 });
    expect(served.body.effectiveOn < addMonths(today(), 3)).toBe(true);
    expect((await invoiceRow(later)).status).toBe('issued');
    const offer = () => db.query<{ status: string }>('select status from renewal where lease_id = $1', [lease]);
    expect((await offer())[0]!.status).toBe('offered');

    const { handler: invoiceRun } = await import('../handlers/invoices-run');
    const period = addMonths(today(), 4);
    await invoiceRun({ periods: [period] });
    const billed = () => db.query<{ status: string }>('select status from invoice where lease_id = $1 and period_start = $2', [lease, period]);
    expect((await billed())[0]?.status).toBe('issued');

    const confirmed = await call('POST', `/terminations/${served.body.id}/confirm`, asTenant(tenantSub));
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.invoicesAdjusted).toBe(2);
    expect((await invoiceRow(later)).status).toBe('void');
    expect((await billed())[0]!.status).toBe('void');
    expect((await offer())[0]!.status).toBe('lapsed');
  });

  it('is chased: the sweep reminds the tenant and tells the landlord, once per interval', async () => {
    const tenantSub = `sub-${randomUUID()}`;
    const { lease } = await leaseFor({ start: plus(-100), end: plus(265), tenantSub });
    await awaitingNotice(lease, plus(20), { recordedDaysAgo: 4 });
    const { handler: sweep } = await import('../handlers/notifications-sweep');
    await sweep();
    await sweep();
    // One reminder each, however often the sweep runs that day.
    const tenant = await sentTo(lease, 'notice_confirm_reminder');
    expect(new Set(tenant.map((row) => row.recipient_sub))).toEqual(new Set([tenantSub]));
    // Email and WhatsApp, once each.
    expect(tenant).toHaveLength(2);
    const landlord = await sentTo(lease, 'notice_awaiting_tenant');
    expect(new Set(landlord.map((row) => row.recipient_sub))).toEqual(new Set(['sub-landlord']));
    expect(landlord).toHaveLength(1);
  });

  it('once its end date has passed the landlord is told to attach the notice or withdraw; the tenant is not asked', async () => {
    const tenantSub = `sub-${randomUUID()}`;
    const { lease } = await leaseFor({ start: plus(-100), end: plus(265), tenantSub });
    await awaitingNotice(lease, plus(-2), { recordedDaysAgo: 1 });
    const { handler: sweep } = await import('../handlers/notifications-sweep');
    await sweep();
    expect(await sentTo(lease, 'notice_confirm_reminder')).toHaveLength(0);
    const [told] = await sentTo(lease, 'notice_awaiting_tenant');
    expect(told!.body).toMatch(/passed/);
  });

  it('cannot be confirmed once its end date has passed', async () => {
    const tenantSub = `sub-${randomUUID()}`;
    const { lease } = await leaseFor({ start: plus(-100), end: plus(265), tenantSub });
    const id = await awaitingNotice(lease, plus(-1));
    const late = await call('POST', `/terminations/${id}/confirm`, asTenant(tenantSub));
    expect(late.status).toBe(409);
    expect(late.body.error.message).toMatch(/fresh notice/);
  });

  it('the landlord attests with the written notice: it stands, is audited, and the tenant is told and may withdraw', async () => {
    const tenantSub = `sub-${randomUUID()}`;
    const { lease } = await leaseFor({ start: plus(-100), end: plus(265), tenantSub });
    const later = await invoice(lease, addMonths(today(), 3));
    const id = await awaitingNotice(lease, plus(20));

    expect((await call('POST', `/terminations/${id}/attest`, { body: { statement: STATEMENT } })).status).toBe(400);
    const other = await leaseFor({ start: plus(-100), end: plus(265) });
    const foreign = await evidenceFor(other.lease);
    expect((await call('POST', `/terminations/${id}/attest`, { body: { evidenceKey: foreign, statement: STATEMENT } })).status).toBe(400);
    expect((await call('POST', `/terminations/${id}/attest`, { ...asTenant(tenantSub), body: { evidenceKey: foreign, statement: STATEMENT } })).status).toBe(403);

    const evidenceKey = await evidenceFor(lease);
    const attested = await call('POST', `/terminations/${id}/attest`, { body: { evidenceKey, statement: STATEMENT } });
    expect(attested.status).toBe(200);
    expect(attested.body).toMatchObject({ id, attested: true, effectiveOn: plus(20), invoicesAdjusted: 1 });
    expect((await invoiceRow(later)).status).toBe('void');
    expect((await call('POST', `/terminations/${id}/attest`, { body: { evidenceKey, statement: STATEMENT } })).status).toBe(409);

    const got = await call('GET', `/leases/${lease}`, asTenant(tenantSub));
    expect(got.body.termination).toMatchObject({ awaitingTenant: false, attested: true });
    expect(got.body.termination.attestation).toMatchObject({ statement: STATEMENT });
    // Both parties can open the evidence.
    const view = await call('POST', '/files/view', { ...asTenant(tenantSub), body: { key: got.body.termination.attestation.evidenceKey } });
    expect(view.status).toBe(200);

    const [log] = await db.query<{ actor_sub: string }>(
      `select actor_sub from audit_log where action = 'termination.attested' and entity_id = $1`, [id]);
    expect(log?.actor_sub).toBe('sub-landlord');
    const [told] = await sentTo(lease, 'notice_attested');
    expect(told?.recipient_sub).toBe(tenantSub);
    expect(told!.body).toMatch(/withdraw/i);

    // The tenant disputes it by withdrawing, and the trimmed invoice comes back.
    expect((await call('POST', `/terminations/${id}/withdraw`, asTenant(tenantSub))).status).toBe(200);
    expect((await invoiceRow(later)).status).toBe('issued');
  });

  it('an agent may attest, and an attested notice past its end date can be settled', async () => {
    const agent = `sub-agent-${randomUUID()}`;
    await db.query(`insert into landlord_member (landlord_id, sub, role) values ($1, $2, 'agent')`, [LANDLORD_ID, agent]);
    const ids = await settleable({ tenantSub: `sub-${randomUUID()}` });
    await db.query('update termination set needs_tenant_confirmation = true where id = $1', [ids.terminationId]);
    const before = await call('GET', `/terminations/${ids.terminationId}/settlement`);
    expect(before.body.blocker).toMatch(/not confirmed/);
    const evidenceKey = await evidenceFor(ids.lease, { sub: agent });
    const attested = await call('POST', `/terminations/${ids.terminationId}/attest`, { sub: agent, body: { evidenceKey, statement: STATEMENT } });
    expect(attested.status).toBe(200);
    expect((await call('GET', `/terminations/${ids.terminationId}/settlement`)).body.blocker).toBeNull();
  });

  it('a notice for an imported tenant with no account needs the written notice attached', async () => {
    const { lease } = await leaseFor({ start: plus(-100), end: plus(265) });
    const body = { initiatedBy: 'tenant', reason: 'early_tenant' };
    const bare = await call('POST', `/leases/${lease}/termination`, { body });
    expect(bare.status).toBe(409);
    expect(bare.body.error.message).toMatch(/written notice/);
    const half = await call('POST', `/leases/${lease}/termination`, { body: { ...body, statement: STATEMENT } });
    expect(half.status).toBe(400);
    const evidenceKey = await evidenceFor(lease);
    const served = await call('POST', `/leases/${lease}/termination`, { body: { ...body, evidenceKey, statement: STATEMENT } });
    expect(served.status).toBe(201);
    expect(served.body).toMatchObject({ awaitingTenant: false, attested: true });
    const got = await call('GET', `/leases/${lease}`);
    expect(got.body.termination).toMatchObject({ awaitingTenant: false, attested: true });
  });
});

describe('money 3: a bank line whose slip was accepted for a different amount', () => {
  it('is linked to the slip’s payment, not recorded a second time', async () => {
    const { lease } = await leaseFor({ start: plus(-100), end: plus(265), tenantSub: `sub-${randomUUID()}` });
    const first = await invoice(lease, addMonths(today(), -1));
    await invoice(lease, addMonths(today(), 0));
    const [proof] = await db.query<{ id: string }>(
      `insert into payment_proof (lease_id, target, invoice_id, amount_cents, paid_on, reference, s3_key, content_type,
                                  size_bytes, status, submitted_by, submitted_at)
       values ($1, 'invoice', $2, 700000, $3, 'slip', $4, 'application/pdf', 10, 'accepted', 'sub-tenant', now()) returning id`,
      [lease, first, plus(-3), `proofs/a6-${randomUUID()}.pdf`],
    );
    await db.query(
      `insert into payment (lease_id, invoice_id, amount_cents, method, reference, received_on, recorded_by, proof_id)
       values ($1, $2, 690000, 'eft', 'slip', $3, 'sub-landlord', $4)`,
      [lease, first, plus(-3), proof!.id],
    );
    await db.query(`update invoice set status = 'part_paid' where id = $1`, [first]);
    const imported = await call('POST', '/bank-imports', {
      body: { fileName: `a6-${randomUUID()}.csv`, content: `Date,Description,Amount\n${plus(-2)},RENT A6 ${randomUUID()},6900.00\n` },
    });
    expect(imported.status).toBe(201);
    const [line] = await db.query<{ id: string }>('select id from bank_line where import_id = $1', [imported.body.id]);
    const resolved = await call('POST', `/bank-imports/${imported.body.id}/resolve`, { body: { lines: [{ lineId: line!.id, leaseId: lease }] } });
    expect(resolved.status).toBe(200);
    const [sum] = await db.query<{ s: string }>('select sum(amount_cents)::text s from payment where lease_id = $1', [lease]);
    expect(sum!.s).toBe('690000');
    const [linked] = await db.query<{ bank_line_id: string }>('select bank_line_id from payment where proof_id = $1', [proof!.id]);
    expect(linked!.bank_line_id).toBe(line!.id);
  });
});

describe('money 4: withdrawing an application whose unsigned lease already holds a deposit', () => {
  it('writes the deposit off the ledger as a refund and tells the landlord to pay it back', async () => {
    const ids = await leaseFor({ start: plus(10), end: plus(375), status: 'out_for_signature' });
    await deposit(ids.lease);
    const withdrawn = await call('POST', `/applications/${ids.application}/withdraw`);
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.depositToRefundCents).toBe(700000);
    const [ledger] = await db.query<{ balance: string }>(
      `select sum(case when entry_type in ('received', 'interest') then amount_cents else -amount_cents end)::text as balance
         from deposit_ledger where lease_id = $1`, [ids.lease]);
    expect(ledger!.balance).toBe('0');
  });
});

describe('money 5: ending a lease on its own end date', () => {
  it('a tenant can give end-of-term notice on the last day of the term', async () => {
    const tenantSub = `sub-${randomUUID()}`;
    const { lease } = await leaseFor({ start: plus(-364), end: today(), tenantSub });
    const served = await call('POST', `/leases/${lease}/termination`, {
      ...asTenant(tenantSub), body: { initiatedBy: 'tenant', reason: 'end_of_term' },
    });
    expect(served.status).toBe(201);
    expect(served.body.effectiveOn).toBe(today());
  });

  it('a landlord can record, after the end date, a tenant’s end-of-term notice that ended the lease on it', async () => {
    const tenantSub = `sub-${randomUUID()}`;
    const { lease } = await leaseFor({ start: plus(-370), end: plus(-5), tenantSub });
    const body = { initiatedBy: 'tenant', reason: 'end_of_term', noticeGivenOn: plus(-20) };
    const byDefault = await call('POST', `/leases/${lease}/termination`, { body });
    expect(byDefault.status).toBe(201);
    expect(byDefault.body.effectiveOn).toBe(plus(-5));
    expect((await call('POST', `/terminations/${byDefault.body.id}/withdraw`)).status).toBe(200);
    const explicit = await call('POST', `/leases/${lease}/termination`, { body: { ...body, effectiveOn: plus(-5) } });
    expect(explicit.status).toBe(201);
  });
});

describe('money 6: an imported lease is caught up on months it missed', () => {
  it('from the month it was brought in, not before', async () => {
    // Far enough back that no other lease in this file has a missed month there.
    const { lease } = await leaseFor({ start: addMonths(today(), -40), end: plus(300) });
    await db.query(`update lease set source = 'import', activated_at = $2::date where id = $1`, [lease, addMonths(today(), -30)]);
    const { handler: invoiceRun, missedPeriods } = await import('../handlers/invoices-run');
    const missed = await missedPeriods(addMonths(today(), 0));
    expect(missed).toContain(addMonths(today(), -30));
    expect(missed).not.toContain(addMonths(today(), -31));
    await invoiceRun({ periods: [addMonths(today(), -29), addMonths(today(), -31)] });
    const periods = (await db.query<{ p: string }>(
      'select period_start::text as p from invoice where lease_id = $1 order by 1', [lease])).map((row) => row.p);
    expect(periods).toEqual([addMonths(today(), -29)]);
  });
});

describe('money 7: interest on a deposit recorded after the month’s run', () => {
  it('a second run raises the month’s interest to the balance now on record', async () => {
    const { lease } = await leaseFor({ start: plus(-100), end: plus(265) });
    const before = addMonths(today(), -2);
    await db.query(`insert into deposit_ledger (lease_id, entry_type, amount_cents, occurred_on, note) values ($1, 'received', 100000, $2, 'Deposit')`, [lease, before]);
    const { handler: interestRun } = await import('../handlers/interest-run');
    await interestRun();
    const interest = async () => (await db.query<{ amount_cents: string }>(
      `select amount_cents::text from deposit_ledger where lease_id = $1 and entry_type = 'interest'`, [lease]));
    const first = Number((await interest())[0]!.amount_cents);
    // A top-up paid last month, entered after this month's run.
    await db.query(`insert into deposit_ledger (lease_id, entry_type, amount_cents, occurred_on, note) values ($1, 'received', 600000, $2, 'Top-up')`, [lease, before]);
    await interestRun();
    const rows = await interest();
    expect(rows).toHaveLength(1);
    const raised = Number(rows[0]!.amount_cents);
    expect(raised).toBeGreaterThan(first * 6);
    // And never lowered.
    await db.query(`delete from deposit_ledger where lease_id = $1 and note = 'Top-up'`, [lease]);
    await interestRun();
    expect(Number((await interest())[0]!.amount_cents)).toBe(raised);
  });
});

describe('money 8: a cancelled payment notice during the trial', () => {
  it('leaves the trial running', async () => {
    const [landlord] = await db.query<{ id: string }>(
      `insert into landlord (trading_name, email, phone) values ('Trial Rentals', 'trial-a6@example.co.za', '0825550909') returning id`);
    const token = `tok-${randomUUID()}`;
    await db.query('update subscription set provider_token = $2 where landlord_id = $1', [landlord!.id, token]);
    const { applyPaymentNotice } = await import('../lib/billing-events');
    await applyPaymentNotice({ provider: 'local', externalId: `a6-${randomUUID()}`, checkoutId: null, token, outcome: 'cancelled', amountCents: null, payload: {} });
    const [sub] = await db.query<{ status: string }>('select status from subscription where landlord_id = $1', [landlord!.id]);
    expect(sub!.status).toBe('trialing');
  });
});

describe('money 9: an OFX file with two accounts', () => {
  it('fingerprints each line with its own account', async () => {
    const { parseStatement } = await import('../domain/bank-statement');
    const block = (account: string) =>
      `<STMTTRNRS><STMTRS><BANKACCTFROM><BANKID>1<ACCTID>${account}</BANKACCTFROM><BANKTRANLIST>` +
      `<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261101<TRNAMT>7000.00<FITID>0001<NAME>RENT</STMTTRN>` +
      `</BANKTRANLIST></STMTRS></STMTTRNRS>`;
    const parsed = parseStatement('two.ofx', `OFXHEADER:100\n<OFX><BANKMSGSRSV1>${block('111')}${block('222')}</BANKMSGSRSV1></OFX>`);
    expect(parsed.lines).toHaveLength(2);
    expect(parsed.lines[0]!.fingerprint).not.toBe(parsed.lines[1]!.fingerprint);
    const single = parseStatement('one.ofx', `OFXHEADER:100\n<OFX><BANKMSGSRSV1>${block('111')}</BANKMSGSRSV1></OFX>`);
    expect(single.lines[0]!.fingerprint).toBe(parsed.lines[0]!.fingerprint);
  });
});

describe('app 3: the statement says what deposit is still owed', () => {
  it('returns depositOwingCents', async () => {
    const tenantSub = `sub-${randomUUID()}`;
    const { lease } = await leaseFor({ start: plus(-10), end: plus(355), tenantSub });
    await deposit(lease, 200000);
    const statement = await call('GET', `/leases/${lease}/statement`, asTenant(tenantSub));
    expect(statement.body.depositOwingCents).toBe(500000);
  });
});

describe('app 6: the approved list after a renewal', () => {
  it('lists the application once, with its latest lease', async () => {
    const first = await leaseFor({ start: plus(-400), end: plus(-36), status: 'terminated' });
    const [renewal] = await db.query<{ id: string }>(
      `insert into lease (application_id, unit_id, applicant_id, start_date, end_date, monthly_rent_cents,
                          escalation_pct, deposit_cents, status, previous_lease_id)
       values ($1, $2, $3, $4, $5, 700000, 0, 700000, 'active', $6) returning id`,
      [first.application, first.unit, first.applicant, plus(-35), plus(330), first.lease],
    );
    const listed = await call('GET', '/applications', { query: { status: 'approved', limit: '100' } });
    const mine = listed.body.items.filter((item: { id: string }) => item.id === first.application);
    expect(mine).toHaveLength(1);
    expect(mine[0].leaseId).toBe(renewal!.id);
  });
});

describe('app 9: a payment dated long before the lease', () => {
  it('is refused more than 60 days before the lease start', async () => {
    const { lease } = await leaseFor({ start: plus(-100), end: plus(265) });
    const inv = await invoice(lease, addMonths(today(), 0));
    const body = { target: 'invoice', invoiceId: inv, amountCents: 100000, method: 'eft' };
    const typo = await call('POST', `/leases/${lease}/payments`, { body: { ...body, receivedOn: '2006-11-01' } });
    expect(typo.status).toBe(400);
    expect(typo.body.error.message).toMatch(/before the lease/);
    expect((await call('POST', `/leases/${lease}/payments`, { body: { ...body, receivedOn: plus(-150) } })).status).toBe(201);
  });
});

describe('app 11: the settlement preview before the lease has ended', () => {
  it('names that as the blocker', async () => {
    const { lease } = await leaseFor({ start: plus(-100), end: plus(265) });
    const id = await termination(lease, plus(10));
    const preview = await call('GET', `/terminations/${id}/settlement`);
    expect(preview.status).toBe(200);
    expect(preview.body.blocker).toMatch(/runs until/);
  });
});

describe('app low: invoices on the lease page', () => {
  it('returns every open invoice as well as the latest twelve', async () => {
    const { lease } = await leaseFor({ start: plus(-500), end: plus(265) });
    const ids: string[] = [];
    for (let back = 14; back >= 1; back -= 1) {
      ids.push(await invoice(lease, addMonths(today(), -back), 700000, { status: back === 14 ? 'issued' : 'paid' }));
    }
    const got = await call('GET', `/leases/${lease}`);
    const listed = got.body.invoices.map((row: { id: string }) => row.id);
    expect(listed).toHaveLength(13);
    expect(listed).toContain(ids[0]);
    expect(listed).not.toContain(ids[1]);
    // Newest first, as before.
    expect(listed[0]).toBe(ids[13]);
  });
});

describe('gap 2: reversing a recorded payment', () => {
  it('writes a negative entry, re-opens the invoice, is audited and idempotent', async () => {
    const tenantSub = `sub-${randomUUID()}`;
    const { lease } = await leaseFor({ start: plus(-100), end: plus(265), tenantSub });
    const inv = await invoice(lease, addMonths(today(), 0));
    const recorded = await call('POST', `/leases/${lease}/payments`, {
      body: { target: 'invoice', invoiceId: inv, amountCents: 700000, method: 'eft', receivedOn: plus(-1) },
    });
    expect(recorded.status).toBe(201);
    expect((await invoiceRow(inv)).status).toBe('paid');
    const statement = await call('GET', `/leases/${lease}/statement`);
    const paymentId = statement.body.payments[0].id as string;

    expect((await call('POST', `/payments/${paymentId}/reverse`, { body: {} })).status).toBe(400);
    expect((await call('POST', `/payments/${paymentId}/reverse`, { ...asTenant(tenantSub), body: { reason: 'Not mine' } })).status).toBe(403);

    const reversed = await call('POST', `/payments/${paymentId}/reverse`, { body: { reason: 'Recorded on the wrong lease' } });
    expect(reversed.status).toBe(201);
    expect(reversed.body).toMatchObject({
      paymentId, amountCents: -700000, invoiceId: inv, invoiceStatus: 'issued', paidCents: 0, totalCents: 700000,
    });
    expect((await invoiceRow(inv)).status).toBe('issued');

    const again = await call('POST', `/payments/${paymentId}/reverse`, { body: { reason: 'Recorded on the wrong lease' } });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ reversalId: reversed.body.reversalId, duplicate: true });
    const rows = await db.query<{ amount_cents: string; method: string }>(
      'select amount_cents::text, method from payment where lease_id = $1 order by created_at, amount_cents desc', [lease]);
    expect(rows).toEqual([{ amount_cents: '700000', method: 'eft' }, { amount_cents: '-700000', method: 'reversal' }]);
    // A reversal is not itself reversed.
    expect((await call('POST', `/payments/${reversed.body.reversalId}/reverse`, { body: { reason: 'Undo the undo' } })).status).toBe(409);

    const after = await call('GET', `/leases/${lease}/statement`);
    expect(after.body.balanceCents).toBe(700000);
    const original = after.body.payments.find((row: { id: string }) => row.id === paymentId);
    expect(original).toMatchObject({ reversedBy: reversed.body.reversalId });
    const entry = after.body.payments.find((row: { id: string }) => row.id === reversed.body.reversalId);
    expect(entry).toMatchObject({ method: 'reversal', reversesPaymentId: paymentId, reason: 'Recorded on the wrong lease' });

    const [log] = await db.query<{ detail: { reason: string } }>(
      `select detail from audit_log where action = 'payment.reversed' and entity_id = $1`, [lease]);
    expect(log!.detail.reason).toBe('Recorded on the wrong lease');
  });

  it('leaves a part-paid invoice part paid', async () => {
    const { lease } = await leaseFor({ start: plus(-100), end: plus(265) });
    const inv = await invoice(lease, addMonths(today(), 0), 700000, { status: 'paid' });
    await pay(lease, inv, 300000);
    const second = await pay(lease, inv, 400000);
    const reversed = await call('POST', `/payments/${second}/reverse`, { body: { reason: 'Bounced transfer' } });
    expect(reversed.body).toMatchObject({ invoiceStatus: 'part_paid', paidCents: 300000 });
  });

  it('is refused once the deposit is settled, and for money the settlement itself moved', async () => {
    const ids = await settleable();
    const inv = await invoice(ids.lease, addMonths(today(), -1), 700000, { status: 'part_paid' });
    const paid = await pay(ids.lease, inv, 300000, plus(-20));
    expect((await call('POST', `/terminations/${ids.terminationId}/settle`, { body: {} })).status).toBe(200);
    const refused = await call('POST', `/payments/${paid}/reverse`, { body: { reason: 'Too late to fix' } });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/settled/);
  });
});

describe('gap 8: recording that the refund was paid', () => {
  it('takes a date and a reference on a settled termination and shows them on the lease', async () => {
    const tenantSub = `sub-${randomUUID()}`;
    const ids = await settleable({ tenantSub });
    const early = await call('POST', `/terminations/${ids.terminationId}/refund-paid`, { body: { paidOn: today(), reference: 'EFT 123' } });
    expect(early.status).toBe(409);
    expect((await call('POST', `/terminations/${ids.terminationId}/settle`, { body: {} })).status).toBe(200);

    expect((await call('POST', `/terminations/${ids.terminationId}/refund-paid`, { body: { paidOn: today() } })).status).toBe(400);
    expect((await call('POST', `/terminations/${ids.terminationId}/refund-paid`, { body: { paidOn: plus(1), reference: 'EFT 123' } })).status).toBe(400);
    expect((await call('POST', `/terminations/${ids.terminationId}/refund-paid`, { ...asTenant(tenantSub), body: { paidOn: today(), reference: 'EFT 123' } })).status).toBe(403);

    const paid = await call('POST', `/terminations/${ids.terminationId}/refund-paid`, { body: { paidOn: today(), reference: 'EFT 123' } });
    expect(paid.status).toBe(200);
    expect(paid.body).toMatchObject({ id: ids.terminationId, refundCents: 700000, refundPaidOn: today(), refundReference: 'EFT 123' });

    const got = await call('GET', `/leases/${ids.lease}`, asTenant(tenantSub));
    expect(got.body.termination).toMatchObject({ refundCents: 700000, refundPaidOn: today(), refundReference: 'EFT 123' });
    const [log] = await db.query<{ id: string }>(
      `select id from audit_log where action = 'termination.refund_paid' and entity_id = $1`, [ids.terminationId]);
    expect(log).toBeTruthy();

    // Paid, so the landlord is no longer warned that it is due.
    await db.query(`update termination set refund_due_by = $2 where id = $1`, [ids.terminationId, plus(1)]);
    const { handler: sweep } = await import('../handlers/notifications-sweep');
    await sweep();
    expect(await sentTo(ids.lease, 'refund_due_soon')).toHaveLength(0);
  });
});
