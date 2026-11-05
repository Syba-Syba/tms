import { beforeAll, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Money audit, third round: one transfer counted twice (slip and bank line), months never
    billed, rent credit ignored by arrears, unpaid upgrades, and a phantom deposit owed. */
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const PROPERTY = '22222222-2222-2222-2222-222222222222';
const APPLICANT = '44444444-4444-4444-4444-444444444444';
const LANDLORD_ID = '11111111-1111-1111-1111-111111111111';
const LANDLORD = { sub: 'sub-landlord', groups: '[landlord]' };
const TENANT = { sub: 'sub-tenant', groups: '[tenant]' };

let call: (method: string, path: string, body?: unknown, who?: { sub: string; groups: string }) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let dates: typeof import('../domain/dates');
let bill: typeof import('../handlers/invoices-run').handler;
let billing: typeof import('../lib/billing');
let arrears: typeof import('../lib/arrears');

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://money-audit-3-${Date.now()}`;
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
  ({ handler: bill } = await import('../handlers/invoices-run'));
  billing = await import('../lib/billing');
  arrears = await import('../lib/arrears');

  const { handler } = await import('../api');
  call = async (method, path, body, who = LANDLORD) => {
    const event = {
      rawPath: path,
      headers: { 'content-type': 'application/json' },
      queryStringParameters: {},
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

const invoicesOf = (leaseId: string) =>
  db.query<{ id: string; period_start: string; total_cents: string; status: string; paid: string; covers_from: string }>(
    `select i.id, i.period_start::text, i.total_cents::text, i.status, i.covers_from::text,
            coalesce((select sum(amount_cents) from payment where invoice_id = i.id), 0)::text as paid
       from invoice i where i.lease_id = $1 order by i.period_start`,
    [leaseId],
  );

let slipNo = 0;
async function pendingSlip(leaseId: string, target: 'invoice' | 'deposit', amountCents: number, paidOn: string) {
  slipNo += 1;
  const [proof] = await db.query<{ id: string }>(
    `insert into payment_proof (lease_id, target, amount_cents, paid_on, reference, s3_key, content_type, size_bytes,
                                status, submitted_by, submitted_at)
     values ($1, $2, $3, $4, 'slip', $5, 'application/pdf', 10, 'pending', 'sub-tenant', now()) returning id`,
    [leaseId, target, amountCents, paidOn, `proofs/test-${slipNo}.pdf`],
  );
  return proof!.id;
}

let lineNo = 0;
async function bankLine(amountCents: number, postedOn: string, description: string) {
  lineNo += 1;
  const [imported] = await db.query<{ id: string }>(
    `insert into bank_import (landlord_id, file_name, format, imported_by) values ($1, 's.csv', 'csv', 'sub-landlord') returning id`,
    [LANDLORD_ID],
  );
  const [line] = await db.query<{ id: string }>(
    `insert into bank_line (import_id, landlord_id, posted_on, amount_cents, description, fingerprint)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [imported!.id, LANDLORD_ID, postedOn, amountCents, description, `fp-${lineNo}-${Date.now()}`],
  );
  return { importId: imported!.id, lineId: line!.id };
}

describe('a deposit slip and its bank line (bug 1)', () => {
  it('matches the bank line to the accepted deposit slip instead of recording it as rent', async () => {
    const lease = await makeLease({ start: '2026-10-01', end: '2027-09-30' });
    // October's rent is open, so before the fix the line went straight onto it.
    await bill({ periods: ['2026-10-01'] });
    const slip = await pendingSlip(lease.id, 'deposit', 850000, '2026-10-20');
    const accepted = await call('POST', `/payment-proofs/${slip}/decision`, { decision: 'accept' });
    expect(accepted.status).toBe(200);

    const line = await bankLine(850000, '2026-10-21', `DEPOSIT ${lease.ref} 8500.00`);
    const resolved = await call('POST', `/bank-imports/${line.importId}/resolve`, { lines: [{ lineId: line.lineId, leaseId: lease.id }] });
    expect(resolved.status).toBe(200);
    expect(resolved.body.results[0]).toEqual({ lineId: line.lineId, ok: true });

    expect(await db.query('select 1 from payment where lease_id = $1', [lease.id])).toHaveLength(0);
    const ledger = await db.query<{ amount_cents: string; proof_id: string; bank_line_id: string }>(
      `select amount_cents::text, proof_id, bank_line_id from deposit_ledger where lease_id = $1`,
      [lease.id],
    );
    expect(ledger).toEqual([{ amount_cents: '850000', proof_id: slip, bank_line_id: line.lineId }]);
    const [row] = await db.query<{ status: string; proof_id: string }>('select status, proof_id from bank_line where id = $1', [line.lineId]);
    expect(row).toEqual({ status: 'matched', proof_id: slip });
  });
});

describe('a slip accepted after its bank line was recorded (bug 2)', () => {
  it('links the slip to the bank line’s payment instead of recording the money again', async () => {
    const lease = await makeLease({ start: '2026-01-01', end: '2026-12-31' });
    await bill({ periods: ['2026-10-01', '2026-11-01'] });
    const line = await bankLine(900000, '2026-10-02', `${lease.ref} RENT`);
    const resolved = await call('POST', `/bank-imports/${line.importId}/resolve`, { lines: [{ lineId: line.lineId, leaseId: lease.id }] });
    expect(resolved.body.results[0]).toMatchObject({ ok: true });

    const slip = await pendingSlip(lease.id, 'invoice', 900000, '2026-10-01');
    const accepted = await call('POST', `/payment-proofs/${slip}/decision`, { decision: 'accept' });
    expect(accepted.status).toBe(200);

    const payments = await db.query<{ amount_cents: string; proof_id: string | null; bank_line_id: string }>(
      'select amount_cents::text, proof_id, bank_line_id from payment where lease_id = $1',
      [lease.id],
    );
    expect(payments).toEqual([{ amount_cents: '900000', proof_id: slip, bank_line_id: line.lineId }]);
    const [, november] = await invoicesOf(lease.id);
    expect(november).toMatchObject({ status: 'issued', paid: '0' });
    const [proof] = await db.query<{ status: string }>('select status from payment_proof where id = $1', [slip]);
    expect(proof!.status).toBe('accepted');
  });
});

describe('rent credit and arrears (bug 4)', () => {
  it('moves rent paid past the notice date onto open invoices, so arrears are not overstated', async () => {
    const lease = await makeLease({ start: '2026-01-01', end: '2026-12-31' });
    await bill({ periods: ['2026-10-01', '2026-11-01'] });
    const [october, november] = await invoicesOf(lease.id);
    // November paid in full, October never.
    await db.query(
      `insert into payment (lease_id, invoice_id, amount_cents, method, received_on, recorded_by)
       values ($1, $2, 900000, 'eft', '2026-10-28', 'test')`,
      [lease.id, november!.id],
    );
    await db.query(`update invoice set status = 'paid' where id = $1`, [november!.id]);

    await db.withTransaction((run) => billing.trimInvoicesAfter(run, lease.id, '2026-11-10'));
    const after = await invoicesOf(lease.id);
    // November is now 10 days: R3 000. The R6 000 paid above that settles most of October.
    expect(after[1]).toMatchObject({ total_cents: '300000', paid: '300000', status: 'paid' });
    expect(after[0]).toMatchObject({ id: october!.id, paid: '600000', status: 'part_paid' });

    const [owing] = await arrears.owingLeases('2026-12-15', lease.id);
    expect(owing!.outstandingCents).toBe(300000);
  });

  it('nets any credit left on a paid invoice against the overdue ones, in reminders, the letter and the ageing', async () => {
    const lease = await makeLease({ start: '2026-01-01', end: '2026-12-31' });
    const today = dates.sastToday();
    const [overpaid] = await db.query<{ id: string }>(
      `insert into invoice (lease_id, period_start, due_on, total_cents, status)
       values ($1, '2026-07-01', '2026-07-01', 900000, 'paid') returning id`,
      [lease.id],
    );
    await db.query(
      `insert into payment (lease_id, invoice_id, amount_cents, method, received_on, recorded_by)
       values ($1, $2, 1000000, 'eft', '2026-07-01', 'test')`,
      [lease.id, overpaid!.id],
    );
    await db.query(
      `insert into invoice (lease_id, period_start, due_on, total_cents, status)
       values ($1, '2026-08-01', '2026-08-01', 900000, 'issued')`,
      [lease.id],
    );
    const [owing] = await arrears.owingLeases(today, lease.id);
    expect(owing!.outstandingCents).toBe(800000);

    const report = await call('GET', '/reports/arrears');
    const item = report.body.items.find((row: { leaseId: string }) => row.leaseId === lease.id);
    expect(item.totalCents).toBe(800000);

    const letter = await call('POST', `/leases/${lease.id}/arrears/letter`);
    expect(letter.status).toBe(201);
    expect(letter.body.outstandingCents).toBe(800000);
  });
});

describe('a plan change waits for its payment (bug 5)', () => {
  it('keeps the allowance of the paid plan until the new price is paid', async () => {
    await db.query(
      `update subscription set status = 'active', plan = 'starter', provider = 'local', provider_token = 'tok-ma3',
              current_period_end = current_date + 20 where landlord_id = $1`,
      [LANDLORD_ID],
    );
    const changed = await call('POST', '/billing/plan', { action: 'change', plan: 'standard' });
    expect(changed).toEqual({ status: 200, body: { plan: 'standard' } });
    const [before] = await db.query<{ plan: string; pending_plan: string | null }>(
      'select plan, pending_plan from subscription where landlord_id = $1',
      [LANDLORD_ID],
    );
    expect(before).toEqual({ plan: 'starter', pending_plan: 'standard' });

    const { applyPaymentNotice } = await import('../lib/billing-events');
    const paid = await applyPaymentNotice({
      provider: 'local', externalId: 'ma3-1', checkoutId: null, token: 'tok-ma3', outcome: 'paid', amountCents: 44_900, payload: {},
    });
    expect(paid).toEqual({ applied: true });
    const [after] = await db.query<{ plan: string; pending_plan: string | null }>(
      'select plan, pending_plan from subscription where landlord_id = $1',
      [LANDLORD_ID],
    );
    expect(after).toEqual({ plan: 'standard', pending_plan: null });
    // Put the account back on its trial for the rest of this file.
    await db.query(
      `update subscription set status = 'trialing', plan = null, provider_token = null, current_period_end = null,
              trial_ends_on = current_date + 30 where landlord_id = $1`,
      [LANDLORD_ID],
    );
  });
});

describe('the deposit the tenant is shown as owing (bug 6)', () => {
  const listed = async (id: string) =>
    (await call('GET', '/leases', undefined, TENANT)).body.items.find((item: { id: string }) => item.id === id);

  it('counts interest towards the deposit after a renewal', async () => {
    const lease = await makeLease({ start: '2026-01-01', end: '2026-12-31' });
    await db.query(
      `insert into deposit_ledger (lease_id, entry_type, amount_cents, occurred_on, note, period_month) values
         ($1, 'received', 850000, '2025-01-01', 'Original deposit', null),
         ($1, 'interest', 50000, '2025-12-31', null, '2025-12-01')`,
      [lease.id],
    );
    expect((await listed(lease.id)).depositOwingCents).toBe(0);
  });

  it('shows the deposit owed on a new tenant’s lease that starts next month', async () => {
    const lease = await makeLease({ start: '2026-12-01', end: '2027-11-30', status: 'scheduled' });
    expect((await listed(lease.id)).depositOwingCents).toBe(900000);
  });

  it('shows nothing owed on a scheduled renewal', async () => {
    const old = await makeLease({ start: '2025-12-01', end: '2026-11-30' });
    const lease = await makeLease({ start: '2026-12-01', end: '2027-11-30', status: 'scheduled', previousId: old.id });
    expect((await listed(lease.id)).depositOwingCents).toBe(0);
  });
});

// Last: the run without periods catches up every lease's missing months.
describe('the invoice run (bug 3)', () => {
  it('tells an imported tenant, who has no sign-in, about the invoice', async () => {
    const [applicant] = await db.query<{ id: string }>(
      `insert into applicant (first_name, last_name, email, phone, monthly_income_cents)
       values ('Imported', 'Tenant', 'imported@example.co.za', '+27820000001', 0) returning id`,
    );
    const lease = await makeLease({ start: '2026-01-01', end: '2026-12-31', applicantId: applicant!.id });
    await bill({ periods: ['2026-09-01'] });
    const sent = await db.query<{ recipient_sub: string }>(
      `select recipient_sub from notification where lease_id = $1 and kind = 'invoice_issued'`,
      [lease.id],
    );
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0]!.recipient_sub).toBe(`applicant:${applicant!.id}`);
  });

  it('bills the days of a month that ended before the lease was activated', async () => {
    const lease = await makeLease({ start: '2026-10-28', end: '2027-10-27' });
    await bill({ now: new Date('2026-11-02T08:00:00Z') });
    const invoices = await invoicesOf(lease.id);
    expect(invoices.map((row) => row.period_start)).toEqual(['2026-10-01', '2026-11-01']);
    expect(invoices[0]).toMatchObject({ covers_from: '2026-10-28', total_cents: String(Math.round((4 * 900000) / 31)) });
  });
});
