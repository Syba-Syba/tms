import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A hook the exit statement render calls first, so a test can record a payment mid-render. */
const midRender: { hook: null | (() => Promise<void>) } = { hook: null };
vi.mock('../lib/pdf', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/pdf')>();
  return {
    ...original,
    renderExitStatementPdf: async (input: Parameters<typeof original.renderExitStatementPdf>[0]) => {
      const hook = midRender.hook;
      midRender.hook = null;
      if (hook) await hook();
      return original.renderExitStatementPdf(input);
    },
  };
});

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const LEASE = '66666666-6666-6666-6666-666666666666';
const PROPERTY = '22222222-2222-2222-2222-222222222222';
const APPLICANT = '44444444-4444-4444-4444-444444444444';

/** Money audit, second round: charges lost at notice and renewal, settlement racing a payment,
    escalation in a mid-month anniversary, and the report's default tax year. */
let call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let dates: typeof import('../domain/dates');
let bill: typeof import('../handlers/invoices-run').handler;
let billing: typeof import('../lib/billing');
let activation: typeof import('../lib/activation');
let renewal: typeof import('../domain/renewal');

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://money-audit-2-${Date.now()}`;
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
  activation = await import('../lib/activation');
  renewal = await import('../domain/renewal');

  const { handler } = await import('../api');
  call = async (method, path, body) => {
    const event = {
      rawPath: path,
      headers: { 'content-type': 'application/json' },
      queryStringParameters: {},
      pathParameters: {},
      body: body ? JSON.stringify(body) : undefined,
      requestContext: {
        http: { method, path, sourceIp: '127.0.0.1', userAgent: 'test' },
        authorizer: { jwt: { claims: { sub: 'sub-landlord', 'cognito:groups': '[landlord]' } } },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
    const result = (await handler(event)) as { statusCode: number; body?: string };
    return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : null };
  };
}, 120_000);

afterEach(() => {
  vi.useRealTimers();
});

let unitNo = 0;
async function makeLease(opts: {
  start: string;
  end: string;
  rent?: number;
  escalation?: number;
  status?: string;
  previous?: { id: string; unitId: string; applicationId: string };
  signed?: boolean;
}) {
  let unitId = opts.previous?.unitId;
  let applicationId = opts.previous?.applicationId;
  if (!unitId) {
    unitNo += 1;
    const [unit] = await db.query<{ id: string }>(
      `insert into unit (property_id, code, bedrooms, bathrooms, monthly_rent_cents, deposit_cents, status)
       values ($1, $2, 1, 1, 900000, 900000, 'occupied') returning id`,
      [PROPERTY, `MA${unitNo}`],
    );
    unitId = unit!.id;
    const [application] = await db.query<{ id: string }>(
      `insert into application (unit_id, applicant_id, status, preferred_move_in)
       values ($1, $2, 'approved', current_date) returning id`,
      [unitId, APPLICANT],
    );
    applicationId = application!.id;
  }
  const [lease] = await db.query<{ id: string }>(
    `insert into lease (application_id, unit_id, applicant_id, start_date, end_date,
                        monthly_rent_cents, escalation_pct, deposit_cents, status, previous_lease_id)
     values ($1, $2, $3, $4, $5, $6, $7, $6, $8, $9) returning id`,
    [applicationId, unitId, APPLICANT, opts.start, opts.end, opts.rent ?? 900000, opts.escalation ?? 0,
      opts.status ?? 'active', opts.previous?.id ?? null],
  );
  if (opts.signed) {
    for (const party of ['landlord', 'tenant']) {
      await db.query(
        `insert into lease_signature (lease_id, party, signature_s3_key, pdf_sha256)
         values ($1, $2, 'test/signature.png', 'sha')`,
        [lease!.id, party],
      );
    }
  }
  return { id: lease!.id, unitId: unitId!, applicationId: applicationId! };
}

const invoicesOf = (leaseId: string) =>
  db.query<{ id: string; period_start: string; total_cents: string; status: string; lines: string }>(
    `select i.id, i.period_start::text, i.total_cents::text, i.status,
            coalesce((select sum(amount_cents) from invoice_line where invoice_id = i.id), 0)::text as lines
       from invoice i where i.lease_id = $1 order by i.period_start`,
    [leaseId],
  );

const addLine = async (invoiceId: string, cents: number, description = 'Water') => {
  await db.query(
    `insert into invoice_line (invoice_id, kind, description, amount_cents) values ($1, 'utility', $2, $3)`,
    [invoiceId, description, cents],
  );
  await db.query('update invoice set total_cents = total_cents + $2 where id = $1', [invoiceId, cents]);
};

const pending = (leaseId: string, period: string, cents = 35000) =>
  db.query(
    `insert into pending_charge (lease_id, period_start, kind, description, amount_cents, added_by)
     values ($1, $2, 'utility', 'Water', $3, 'test')`,
    [leaseId, period, cents],
  );

describe('notice trim and charges on a month nobody occupies (bug 1)', () => {
  it('keeps the utility line on an unpaid month after the notice, with the rent taken off', async () => {
    const lease = await makeLease({ start: '2026-01-01', end: '2026-12-31' });
    await bill({ periods: ['2026-11-01'] });
    const [november] = await invoicesOf(lease.id);
    // October's water, put on the November invoice because October's was already due.
    await addLine(november!.id, 35000, 'Water (October 2026)');

    await db.withTransaction((run) => billing.trimInvoicesAfter(run, lease.id, '2026-10-31'));
    const [after] = await invoicesOf(lease.id);
    expect(after).toMatchObject({ status: 'issued', total_cents: '35000', lines: '35000' });
  });

  it('still voids a month nobody occupies that carries only rent', async () => {
    const lease = await makeLease({ start: '2026-01-01', end: '2026-12-31' });
    await bill({ periods: ['2026-11-01'] });
    await db.withTransaction((run) => billing.trimInvoicesAfter(run, lease.id, '2026-10-31'));
    const [after] = await invoicesOf(lease.id);
    expect(after!.status).toBe('void');
  });
});

describe('charges waiting for a month the renewal bills (bug 2)', () => {
  it('moves to the renewal and is billed when the renewal’s invoice is already out', async () => {
    const old = await makeLease({ start: '2025-12-01', end: '2026-11-30' });
    await pending(old.id, '2026-12-01');
    const next = await makeLease({ start: '2026-12-01', end: '2027-11-30', status: 'scheduled', previous: old, signed: true });
    await bill({ periods: ['2026-12-01'] });

    await db.withTransaction((run) =>
      activation.activateScheduledLease(run, { id: next.id, previous_lease_id: old.id, unit_id: old.unitId }),
    );
    const [december] = await invoicesOf(next.id);
    expect(december).toMatchObject({ period_start: '2026-12-01', total_cents: '935000', lines: '935000' });
    expect(await db.query('select 1 from pending_charge where lease_id = any($1::uuid[])', [[old.id, next.id]])).toHaveLength(0);
  });

  it('moves to the renewal and waits for its invoice when that is not out yet', async () => {
    const old = await makeLease({ start: '2025-12-01', end: '2026-11-30' });
    await pending(old.id, '2026-12-01');
    const next = await makeLease({ start: '2026-12-01', end: '2027-11-30', status: 'scheduled', previous: old, signed: true });
    await db.withTransaction((run) =>
      activation.activateScheduledLease(run, { id: next.id, previous_lease_id: old.id, unit_id: old.unitId }),
    );
    await bill({ periods: ['2026-12-01'] });
    const [december] = await invoicesOf(next.id);
    expect(december).toMatchObject({ total_cents: '935000', lines: '935000' });
  });

  it('movePendingChargesPast puts charges after the last month onto the last invoice', async () => {
    const lease = await makeLease({ start: '2026-01-01', end: '2026-12-31' });
    await bill({ periods: ['2026-10-01', '2026-11-01'] });
    await pending(lease.id, '2026-12-01');
    await pending(lease.id, '2026-11-01', 20000);
    const moved = await db.withTransaction((run) => billing.movePendingChargesPast(run, lease.id, '2026-11-15'));
    expect(moved).toBe(1);
    const [, november] = await invoicesOf(lease.id);
    expect(november).toMatchObject({ total_cents: '935000', lines: '935000' });
    const [line] = await db.query<{ description: string }>(
      `select description from invoice_line where invoice_id = $1 and kind = 'utility'`,
      [november!.id],
    );
    expect(line!.description).toBe('Water (December 2026)');
    // November's own charge is untouched: the run bills it with that month as usual.
    const left = await db.query<{ period_start: string }>(
      'select period_start::text from pending_charge where lease_id = $1',
      [lease.id],
    );
    expect(left).toEqual([{ period_start: '2026-11-01' }]);
  });
});

describe('settling while a payment lands (bug 3)', () => {
  it('refuses when a payment arrives during the render, and the tenant loses nothing', async () => {
    const today = dates.sastToday();
    await db.query('delete from payment where lease_id = $1', [LEASE]);
    await db.query('delete from invoice where lease_id = $1', [LEASE]);
    const [termination] = await db.query<{ id: string }>(
      `insert into termination (lease_id, initiated_by, reason, notice_given_on, effective_on, notice_days)
       values ($1, 'tenant', 'early_tenant', $2::date - 30, $2::date - 2, 20) returning id`,
      [LEASE, today],
    );
    const [invoice] = await db.query<{ id: string }>(
      `insert into invoice (lease_id, period_start, due_on, total_cents)
       values ($1, $2::date - 120, $2::date - 120, 100000) returning id`,
      [LEASE, today],
    );
    midRender.hook = async () => {
      await db.query(
        `insert into payment (lease_id, invoice_id, amount_cents, method, received_on, recorded_by)
         values ($1, $2, 40000, 'eft', $3, 'test')`,
        [LEASE, invoice!.id, today],
      );
      await db.query(`update invoice set status = 'part_paid' where id = $1`, [invoice!.id]);
    };

    const raced = await call('POST', `/terminations/${termination!.id}/settle`, {});
    expect(raced.status).toBe(409);
    expect(raced.body.error.message).toMatch(/Payments changed while the statement was prepared/);
    expect(await db.query(`select 1 from deposit_ledger where lease_id = $1 and entry_type <> 'received'`, [LEASE])).toHaveLength(0);

    const settled = await call('POST', `/terminations/${termination!.id}/settle`, {});
    expect(settled.status).toBe(200);
    expect(settled.body.arrearsCents).toBe(60000);
    const [arrears] = await db.query<{ cents: string }>(
      `select coalesce(sum(amount_cents), 0)::text as cents from deposit_ledger
        where lease_id = $1 and entry_type = 'deduction' and note = 'Rent arrears'`,
      [LEASE],
    );
    expect(arrears!.cents).toBe('60000');
    const [paid] = await db.query<{ status: string }>('select status from invoice where id = $1', [invoice!.id]);
    expect(paid!.status).toBe('paid');
  });
});

describe('escalation in a mid-month anniversary month (bug 4)', () => {
  const window = (from: string, to: string) =>
    renewal.billingWindow({
      periodStart: dates.dateFromIso(from),
      leaseStart: dates.dateFromIso('2026-03-15'),
      leaseEnd: dates.dateFromIso(to),
    })!;
  const rent = (from: string, to: string) =>
    renewal.rentForWindow({
      baseRentCents: 1_000_000,
      escalationPct: 10,
      leaseStart: dates.dateFromIso('2026-03-15'),
      window: window(from, to),
    });

  it('bills the days before the anniversary at the old rent and the rest at the new', () => {
    expect(rent('2027-02-01', '2027-02-28')).toBe(1_000_000);
    // 14 days at R10 000 and 17 at R11 000, over 31.
    expect(rent('2027-03-01', '2027-03-31')).toBe(Math.round((14 * 1_000_000 + 17 * 1_100_000) / 31));
    // Cut short by notice on the 20th: 14 old days and 6 new.
    expect(rent('2027-03-01', '2027-03-20')).toBe(Math.round((14 * 1_000_000 + 6 * 1_100_000) / 31));
    expect(rent('2027-04-01', '2027-04-30')).toBe(1_100_000);
    // The lease's own first month is not an anniversary.
    expect(rent('2026-03-01', '2026-03-31')).toBe(Math.round((17 * 1_000_000) / 31));
  });

  it('the run bills the anniversary month that way', async () => {
    const lease = await makeLease({ start: '2026-03-15', end: '2028-03-14', rent: 1_000_000, escalation: 10 });
    await bill({ periods: ['2027-03-01'] });
    const [march] = await invoicesOf(lease.id);
    expect(march!.total_cents).toBe(String(Math.round((14 * 1_000_000 + 17 * 1_100_000) / 31)));
  });
});

describe('the income and expense report (bug 5)', () => {
  it('defaults to the tax year it is in Johannesburg, not in UTC', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 01:30 on 1 March in Johannesburg, still 28 February in UTC.
    vi.setSystemTime(new Date('2027-02-28T23:30:00Z'));
    const report = await call('GET', '/reports/income-expense');
    vi.useRealTimers();
    expect(report.status).toBe(200);
    expect(report.body.from).toBe('2027-03-01');
    expect(report.body.to).toBe('2028-02-29');
  });
});
