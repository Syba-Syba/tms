import { beforeAll, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addDaysIso, sastToday } from '../domain/dates';

/** Money audit, fifth round: slips linked to the wrong month's bank line, slips that hold the
    arrears ladder for ever, deposit top-ups on a renewal that break its activation, charges on
    a renewal-retired lease, and a lapsed plan that blocked the steps with legal deadlines. */
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const PROPERTY = '22222222-2222-2222-2222-222222222222';
const APPLICANT = '44444444-4444-4444-4444-444444444444';
const LANDLORD_ID = '11111111-1111-1111-1111-111111111111';
const LANDLORD = { sub: 'sub-landlord', groups: '[landlord]' };

let call: (method: string, path: string, body?: unknown, who?: { sub: string; groups: string }) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let activation: typeof import('../lib/activation');
let arrears: typeof import('../lib/arrears');
let gate: typeof import('../lib/billing-gate');

const today = sastToday();

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://money-audit-5-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'tms-storage-'));
  process.env.KMS_DRIVER = 'local';

  db = await import('../lib/db');
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  for (const file of all.filter((n) => !n.includes('seed'))) await db.execScript(read(file));
  for (const file of all.filter((n) => n.includes('seed'))) await db.execScript(read(file));
  activation = await import('../lib/activation');
  arrears = await import('../lib/arrears');
  gate = await import('../lib/billing-gate');

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

let unitNo = 0;
async function makeLease(opts: { start: string; end: string; status?: string; previousId?: string }) {
  unitNo += 1;
  const [unit] = await db.query<{ id: string }>(
    `insert into unit (property_id, code, bedrooms, bathrooms, monthly_rent_cents, deposit_cents, status)
     values ($1, $2, 1, 1, 900000, 900000, 'occupied') returning id`,
    [PROPERTY, `M5-${unitNo}`],
  );
  return leaseOn(unit!.id, opts);
}

async function leaseOn(unitId: string, opts: { start: string; end: string; status?: string; previousId?: string }) {
  const [application] = await db.query<{ id: string }>(
    `insert into application (unit_id, applicant_id, status, preferred_move_in)
     values ($1, $2, 'approved', current_date) returning id`,
    [unitId, APPLICANT],
  );
  const [lease] = await db.query<{ id: string }>(
    `insert into lease (application_id, unit_id, applicant_id, start_date, end_date,
                        monthly_rent_cents, escalation_pct, deposit_cents, status, previous_lease_id)
     values ($1, $2, $3, $4, $5, 900000, 0, 900000, $6, $7) returning id`,
    [application!.id, unitId, APPLICANT, opts.start, opts.end, opts.status ?? 'active', opts.previousId ?? null],
  );
  return { id: lease!.id, unitId };
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

let slipNo = 0;
async function pendingSlip(leaseId: string, target: 'invoice' | 'deposit', amountCents: number, paidOn: string,
  opts: { invoiceId?: string; submittedAt?: string } = {}) {
  slipNo += 1;
  const [proof] = await db.query<{ id: string }>(
    `insert into payment_proof (lease_id, target, invoice_id, amount_cents, paid_on, reference, s3_key, content_type,
                                size_bytes, status, submitted_by, submitted_at)
     values ($1, $2, $3, $4, $5, 'slip', $6, 'application/pdf', 10, 'pending', 'sub-tenant',
             coalesce($7::timestamptz, now())) returning id`,
    [leaseId, target, opts.invoiceId ?? null, amountCents, paidOn, `proofs/m5-${slipNo}.pdf`, opts.submittedAt ?? null],
  );
  return proof!.id;
}

let lineNo = 0;
/** A bank line already matched to the lease, with its payment recorded against `invoiceId`. */
async function bankedPayment(leaseId: string, invoiceId: string, postedOn: string, cents: number) {
  lineNo += 1;
  const [imp] = await db.query<{ id: string }>(
    `insert into bank_import (landlord_id, file_name, format, imported_by) values ($1, 'x.csv', 'csv', 'sub-landlord') returning id`,
    [LANDLORD_ID],
  );
  const [line] = await db.query<{ id: string }>(
    `insert into bank_line (import_id, landlord_id, posted_on, amount_cents, description, fingerprint, status, lease_id)
     values ($1, $2, $3, $4, 'RENT', $5, 'matched', $6) returning id`,
    [imp!.id, LANDLORD_ID, postedOn, cents, `m5-${lineNo}`, leaseId],
  );
  await db.query(
    `insert into payment (lease_id, invoice_id, amount_cents, method, reference, received_on, recorded_by, bank_line_id)
     values ($1, $2, $3, 'eft', 'RENT', $4, 'sub-landlord', $5)`,
    [leaseId, invoiceId, cents, postedOn, line!.id],
  );
  await db.query(`update invoice set status = 'paid' where id = $1`, [invoiceId]);
  return line!.id;
}

const invoiceStatus = async (id: string) =>
  (await db.query<{ status: string }>('select status from invoice where id = $1', [id]))[0]!.status;

describe('a slip accepted next to last month\'s bank line (finding 3)', () => {
  async function setup() {
    const lease = await makeLease({ start: '2026-09-01', end: '2027-08-31' });
    const oct = await invoice(lease.id, '2026-10-01', 900000);
    const nov = await invoice(lease.id, '2026-11-01', 900000);
    await bankedPayment(lease.id, oct, '2026-10-29', 900000);
    return { lease, oct, nov };
  }

  it('records November when the slip names November\'s invoice', async () => {
    const { lease, nov } = await setup();
    const slip = await pendingSlip(lease.id, 'invoice', 900000, '2026-11-01', { invoiceId: nov });
    const res = await call('POST', `/payment-proofs/${slip}/decision`, { decision: 'accept' });
    expect(res.status).toBe(200);
    expect(res.body.linked).toBe(false);
    expect(await invoiceStatus(nov)).toBe('paid');
  });

  it('records it when the slip names no invoice, because the bank line came before the slip', async () => {
    const { lease, nov } = await setup();
    const slip = await pendingSlip(lease.id, 'invoice', 900000, '2026-11-01');
    const res = await call('POST', `/payment-proofs/${slip}/decision`, { decision: 'accept' });
    expect(res.body.linked).toBe(false);
    expect(await invoiceStatus(nov)).toBe('paid');
  });

  it('still links a slip to the bank line for the same invoice, posted after the slip', async () => {
    const { lease, oct, nov } = await setup();
    const slip = await pendingSlip(lease.id, 'invoice', 900000, '2026-10-27', { invoiceId: oct });
    const res = await call('POST', `/payment-proofs/${slip}/decision`, { decision: 'accept' });
    expect(res.body.linked).toBe(true);
    expect(await invoiceStatus(nov)).toBe('issued');
  });

  it('links a slip to its own transfer even when the bank import paid an older invoice with it', async () => {
    const lease = await makeLease({ start: '2026-09-01', end: '2027-08-31' });
    const oct = await invoice(lease.id, '2026-10-01', 900000);
    const nov = await invoice(lease.id, '2026-11-01', 900000);
    // One transfer on 2 Nov; the bank import paid the oldest open invoice, October.
    await bankedPayment(lease.id, oct, '2026-11-02', 900000);
    const slip = await pendingSlip(lease.id, 'invoice', 900000, '2026-11-02', { invoiceId: nov });
    const res = await call('POST', `/payment-proofs/${slip}/decision`, { decision: 'accept' });
    expect(res.body.linked).toBe(true);
    const [sum] = await db.query<{ s: string }>('select sum(amount_cents)::text s from payment where lease_id = $1', [lease.id]);
    expect(sum!.s).toBe('900000');
  });

  it('prefers the bank line that paid the slip\'s invoice when two qualify', async () => {
    const lease = await makeLease({ start: '2026-09-01', end: '2027-08-31' });
    const oct = await invoice(lease.id, '2026-10-01', 900000);
    const nov = await invoice(lease.id, '2026-11-01', 900000);
    await bankedPayment(lease.id, oct, '2026-11-01', 900000);
    const novLine = await bankedPayment(lease.id, nov, '2026-11-03', 900000);
    const slip = await pendingSlip(lease.id, 'invoice', 900000, '2026-11-01', { invoiceId: nov });
    expect((await call('POST', `/payment-proofs/${slip}/decision`, { decision: 'accept' })).body.linked).toBe(true);
    const [p] = await db.query<{ bank_line_id: string }>('select bank_line_id from payment where proof_id = $1', [slip]);
    expect(p!.bank_line_id).toBe(novLine);
  });

  it('links a slip dated one day after the bank posting (a late-night transfer)', async () => {
    const lease = await makeLease({ start: '2026-09-01', end: '2027-08-31' });
    const oct = await invoice(lease.id, '2026-10-01', 900000);
    await bankedPayment(lease.id, oct, '2026-10-02', 900000);
    const slip = await pendingSlip(lease.id, 'invoice', 900000, '2026-10-03', { invoiceId: oct });
    expect((await call('POST', `/payment-proofs/${slip}/decision`, { decision: 'accept' })).body.linked).toBe(true);
  });

  it('does not link a bank line to an accepted slip dated after it', async () => {
    const lease = await makeLease({ start: '2026-09-01', end: '2027-08-31' });
    const oct = await invoice(lease.id, '2026-10-01', 900000);
    const nov = await invoice(lease.id, '2026-11-01', 900000);
    const slip = await pendingSlip(lease.id, 'invoice', 900000, '2026-11-01', { invoiceId: nov });
    expect((await call('POST', `/payment-proofs/${slip}/decision`, { decision: 'accept' })).body.linked).toBe(false);
    // October's transfer, posted 29 Oct, arrives in a statement afterwards.
    const imported = await call('POST', '/bank-imports', {
      fileName: 'oct.csv',
      content: `Date,Description,Amount\n2026-10-29,RENT,9000.00\n`,
    });
    expect(imported.status).toBe(201);
    const [line] = await db.query<{ id: string }>(
      `select id from bank_line where import_id = $1`, [imported.body.id],
    );
    const resolved = await call('POST', `/bank-imports/${imported.body.id}/resolve`, {
      lines: [{ lineId: line!.id, leaseId: lease.id }],
    });
    expect(resolved.status).toBe(200);
    expect(await invoiceStatus(oct)).toBe('paid');
  });
});

describe('a pending slip holding the arrears ladder (finding 5)', () => {
  async function owingLease() {
    const lease = await makeLease({ start: '2026-06-01', end: '2027-05-31' });
    await invoice(lease.id, '2026-08-01', 900000);
    return lease;
  }
  const held = async (leaseId: string) => (await arrears.owingLeases(today, leaseId))[0]!.slipPending;

  it('a deposit slip does not hold the rent reminders', async () => {
    const lease = await owingLease();
    await pendingSlip(lease.id, 'deposit', 1000, today);
    expect(await held(lease.id)).toBe(false);
  });

  it('a fresh rent slip still holds them', async () => {
    const lease = await owingLease();
    await pendingSlip(lease.id, 'invoice', 900000, today);
    expect(await held(lease.id)).toBe(true);
  });

  it('a rent slip left undecided for over a week stops holding them', async () => {
    const lease = await owingLease();
    await pendingSlip(lease.id, 'invoice', 900000, addDaysIso(today, -10), {
      submittedAt: `${addDaysIso(today, -10)}T08:00:00Z`,
    });
    expect(await held(lease.id)).toBe(false);
  });
});

describe('a deposit top-up on a scheduled renewal (finding 60)', () => {
  it('is refused: it belongs on the live lease, where the ledger is', async () => {
    const old = await makeLease({ start: '2025-12-01', end: '2026-11-30' });
    const renewal = await leaseOn(old.unitId, { start: '2026-12-01', end: '2027-11-30', status: 'scheduled', previousId: old.id });
    const res = await call('POST', `/leases/${renewal.id}/payments`, {
      target: 'deposit', amountCents: 50000, receivedOn: today,
    });
    expect(res.status).toBe(409);
    // The live lease still takes it.
    expect((await call('POST', `/leases/${old.id}/payments`, {
      target: 'deposit', amountCents: 50000, receivedOn: today,
    })).status).toBe(201);
  });

  it('a new tenant\'s scheduled lease still takes its deposit', async () => {
    const lease = await makeLease({ start: '2026-12-01', end: '2027-11-30', status: 'scheduled' });
    expect((await call('POST', `/leases/${lease.id}/payments`, {
      target: 'deposit', amountCents: 900000, receivedOn: today,
    })).status).toBe(201);
  });

  it('activation merges interest both leases posted for the same month', async () => {
    const old = await makeLease({ start: '2025-12-01', end: '2026-11-30' });
    const renewal = await leaseOn(old.unitId, { start: '2026-12-01', end: '2027-11-30', status: 'scheduled', previousId: old.id });
    await db.query(
      `insert into deposit_ledger (lease_id, entry_type, amount_cents, occurred_on) values ($1, 'received', 900000, '2025-12-01'),
                                                                                    ($2, 'received', 50000, '2026-10-15')`,
      [old.id, renewal.id],
    );
    await db.query(
      `insert into deposit_ledger (lease_id, entry_type, amount_cents, period_month, occurred_on)
       values ($1, 'interest', 4000, '2026-11-01', '2026-11-01'), ($2, 'interest', 200, '2026-11-01', '2026-11-01')`,
      [old.id, renewal.id],
    );
    await db.withTransaction((run) =>
      activation.activateScheduledLease(run, { id: renewal.id, previous_lease_id: old.id, unit_id: old.unitId }),
    );
    const [lease] = await db.query<{ status: string }>('select status from lease where id = $1', [renewal.id]);
    expect(lease!.status).toBe('active');
    const interest = await db.query<{ amount_cents: string }>(
      `select amount_cents::text from deposit_ledger where lease_id = $1 and entry_type = 'interest'`, [renewal.id],
    );
    expect(interest.map((r) => Number(r.amount_cents))).toEqual([4200]);
  });
});

describe('a charge on a lease a renewal replaced (finding 61)', () => {
  it('is refused with a pointer to the renewal, and the paid invoice is untouched', async () => {
    const old = await makeLease({ start: '2025-10-01', end: '2026-09-30' });
    const sept = await invoice(old.id, '2026-09-01', 900000);
    await db.query(
      `insert into payment (lease_id, invoice_id, amount_cents, method, received_on, recorded_by)
       values ($1, $2, 900000, 'eft', '2026-09-01', 'sub-landlord')`,
      [old.id, sept],
    );
    await db.query(`update invoice set status = 'paid' where id = $1`, [sept]);
    const renewal = await leaseOn(old.unitId, { start: '2026-10-01', end: '2027-09-30', status: 'scheduled', previousId: old.id });
    await db.withTransaction((run) =>
      activation.activateScheduledLease(run, { id: renewal.id, previous_lease_id: old.id, unit_id: old.unitId }),
    );
    const res = await call('POST', `/leases/${old.id}/charges`, {
      period: today.slice(0, 7), kind: 'utility', description: 'Water', amountCents: 45000,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/renew/i);
    expect(await invoiceStatus(sept)).toBe('paid');
  });
});

describe('a lapsed plan (finding 59)', () => {
  const event = (method: string, path: string, body?: unknown) =>
    ({
      rawPath: path,
      headers: {},
      body: body ? JSON.stringify(body) : undefined,
      requestContext: {
        http: { method, path, sourceIp: '127.0.0.1', userAgent: 'test' },
        authorizer: { jwt: { claims: { sub: LANDLORD.sub, 'cognito:groups': LANDLORD.groups } } },
      },
    }) as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
  const id = '99999999-9999-9999-9999-999999999999';
  const refused = async (method: string, path: string, body?: unknown) =>
    (await gate.billingGate(event(method, path, body), path)) !== null;

  it('lapses the account', async () => {
    await db.query(
      `update subscription set status = 'trialing', plan = null, trial_ends_on = $2 where landlord_id = $1`,
      [LANDLORD_ID, addDaysIso(today, -1)],
    );
    expect(await refused('POST', '/properties')).toBe(true);
  });

  it.each([
    ['settling a deposit', 'POST', `/terminations/${id}/settle`],
    ['adding a deduction', 'POST', `/terminations/${id}/deductions`],
    ['removing a deduction', 'DELETE', `/terminations/${id}/deductions/${id}`],
    ['withdrawing a notice', 'POST', `/terminations/${id}/withdraw`],
    ['confirming a notice', 'POST', `/terminations/${id}/confirm`],
    ['answering a privacy request', 'POST', `/privacy-requests/${id}/decision`],
    ['deciding a payment slip', 'POST', `/payment-proofs/${id}/decision`],
    ['recording a payment', 'POST', `/leases/${id}/payments`],
    ['starting an exit inspection', 'POST', `/leases/${id}/inspections`],
    ['recording inspection findings', 'PUT', `/inspections/${id}/findings`],
    ['adding inspection photos', 'POST', `/inspections/${id}/photos/presign`],
    ['signing an inspection', 'POST', `/inspections/${id}/signature`],
    ['reopening an inspection', 'POST', `/inspections/${id}/reopen`],
    ['rendering an inspection', 'POST', `/inspections/${id}/render`],
  ])('still allows %s', async (_label, method, path) => {
    expect(await refused(method, path)).toBe(false);
  });

  it('allows confirming an inspection photo, but not a unit photo', async () => {
    expect(await refused('POST', '/photos/confirm', { scope: 'inspection', photoId: id })).toBe(false);
    expect(await refused('POST', '/photos/confirm', { scope: 'unit', photoId: id })).toBe(true);
  });

  it('still refuses the rest: serving notice, charges, new properties', async () => {
    expect(await refused('POST', `/leases/${id}/termination`)).toBe(true);
    expect(await refused('POST', `/leases/${id}/charges`)).toBe(true);
    expect(await refused('POST', '/properties')).toBe(true);
  });

  it('end to end: a slip can be decided on a lapsed plan', async () => {
    const lease = await makeLease({ start: '2026-09-01', end: '2027-08-31' });
    const slip = await pendingSlip(lease.id, 'invoice', 1000, today);
    const res = await call('POST', `/payment-proofs/${slip}/decision`, { decision: 'reject', reason: 'Not in the account.' });
    expect(res.status).toBe(200);
  });
});
