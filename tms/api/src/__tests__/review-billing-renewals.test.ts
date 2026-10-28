import { beforeAll, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const LEASE = '66666666-6666-6666-6666-666666666666';
const PROPERTY = '22222222-2222-2222-2222-222222222222';
const APPLICANT = '44444444-4444-4444-4444-444444444444';

/** Billing across renewals, notice and holdover, from the review findings. */
type Opts = { sub?: string; groups?: string; body?: unknown };
let call: (method: string, path: string, opts?: Opts) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let dates: typeof import('../domain/dates');
let bill: typeof import('../handlers/invoices-run').handler;
let billing: typeof import('../lib/billing');
let activation: typeof import('../lib/activation');

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://review-billing-renewals-${Date.now()}`;
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

let unitNo = 0;
/** A lease on a unit of its own, so scenarios do not share a unit. */
async function makeLease(opts: {
  start: string;
  end: string;
  rent?: number;
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
      [PROPERTY, `R${unitNo}`],
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
     values ($1, $2, $3, $4, $5, $6, 0, $6, $7, $8) returning id`,
    [applicationId, unitId, APPLICANT, opts.start, opts.end, opts.rent ?? 900000, opts.status ?? 'active',
      opts.previous?.id ?? null],
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
  db.query<{ id: string; period_start: string; total_cents: string; status: string; covers_from: string; covers_to: string }>(
    `select id, period_start::text, total_cents::text, status, covers_from::text, covers_to::text
       from invoice where lease_id = $1 order by period_start`,
    [leaseId],
  );

const pay = (leaseId: string, invoiceId: string, cents: number) =>
  db.query(
    `insert into payment (lease_id, invoice_id, amount_cents, method, received_on, recorded_by)
     values ($1, $2, $3, 'eft', '2026-10-01', 'test')`,
    [leaseId, invoiceId, cents],
  );

const serveNotice = (leaseId: string, effectiveOn: string) =>
  db.query(
    `insert into termination (lease_id, initiated_by, reason, notice_given_on, effective_on, notice_days)
     values ($1, 'landlord', 'mutual', '2026-10-01', $2, 0)`,
    [leaseId, effectiveOn],
  );

/** What settlement counts as owed: each open invoice less what was paid against it. */
const owed = async (leaseId: string) => {
  const [row] = await db.query<{ arrears: string }>(
    `select coalesce(sum(i.total_cents - coalesce((select sum(p.amount_cents) from payment p
                                                    where p.invoice_id = i.id), 0)), 0)::text as arrears
       from invoice i where i.lease_id = $1 and i.status in ('issued', 'part_paid')`,
    [leaseId],
  );
  return Number(row!.arrears);
};

describe('a mid-month renewal changeover (findings 1, 17)', () => {
  it('merges the old lease’s part-month invoice into the renewal’s instead of failing on the unique key', async () => {
    const old = await makeLease({ start: '2026-06-15', end: '2027-06-14' });
    const renewal = await makeLease({
      start: '2027-06-15', end: '2028-06-14', status: 'scheduled', previous: old, signed: true,
    });
    expect((await bill({ periods: ['2027-06-01'] })).issued).toBeGreaterThanOrEqual(2);
    const [oldJune] = await invoicesOf(old.id);
    const [newJune] = await invoicesOf(renewal.id);
    expect(oldJune).toMatchObject({ covers_from: '2027-06-01', covers_to: '2027-06-14', total_cents: '420000' });
    expect(newJune).toMatchObject({ covers_from: '2027-06-15', covers_to: '2027-06-30', total_cents: '480000' });
    await pay(old.id, oldJune!.id, 100000);

    await db.withTransaction((run) =>
      activation.activateScheduledLease(run, { id: renewal.id, previous_lease_id: old.id, unit_id: old.unitId }),
    );

    const statuses = await db.query<{ id: string; status: string }>(
      'select id, status from lease where id = any($1::uuid[])',
      [[old.id, renewal.id]],
    );
    expect(Object.fromEntries(statuses.map((row) => [row.id, row.status]))).toEqual({
      [old.id]: 'terminated',
      [renewal.id]: 'active',
    });
    const [merged] = await invoicesOf(renewal.id);
    expect(merged).toMatchObject({
      id: newJune!.id, total_cents: '900000', status: 'part_paid', covers_from: '2027-06-01', covers_to: '2027-06-30',
    });
    const lines = await db.query<{ amount_cents: string }>(
      'select amount_cents::text from invoice_line where invoice_id = $1 order by amount_cents',
      [merged!.id],
    );
    expect(lines.map((line) => line.amount_cents)).toEqual(['420000', '480000']);
    const [payment] = await db.query<{ lease_id: string; invoice_id: string }>(
      'select lease_id, invoice_id from payment where invoice_id = $1',
      [merged!.id],
    );
    expect(payment).toEqual({ lease_id: renewal.id, invoice_id: merged!.id });
    // Nothing is billed twice and nothing owed is lost: settlement on the renewal sees it all.
    expect(await owed(renewal.id)).toBe(800000);
    expect((await invoicesOf(old.id))[0]).toMatchObject({ status: 'void', total_cents: '0' });
  });

  it('the morning job activates each lease on its own, so one failure does not block the rest', async () => {
    const today = dates.sastToday();
    const yearOn = dates.addDaysIso(today, 365);
    const good = await makeLease({ start: today, end: yearOn, status: 'scheduled', signed: true });
    const bad = await makeLease({ start: today, end: yearOn, status: 'scheduled', signed: true });
    await db.execScript(`
      create function zz_fail_unit() returns trigger language plpgsql as $$
      begin raise exception 'unit update refused'; end $$;
      create trigger zz_fail_unit before update on unit for each row
        when (old.id = '${bad.unitId}') execute function zz_fail_unit();
    `);
    try {
      const { handler: activate } = await import('../handlers/leases-activate');
      const result = await activate();
      expect(result.activated).toBeGreaterThanOrEqual(1);
      const rows = await db.query<{ id: string; status: string }>(
        'select id, status from lease where id = any($1::uuid[])',
        [[good.id, bad.id]],
      );
      expect(Object.fromEntries(rows.map((row) => [row.id, row.status]))).toEqual({
        [good.id]: 'active',
        [bad.id]: 'scheduled',
      });
    } finally {
      await db.execScript('drop trigger zz_fail_unit on unit; drop function zz_fail_unit();');
    }
  });
});

describe('notice on a holding-over lease (finding 2)', () => {
  it('the run bills a holdover lease up to the notice date, not the old end date', async () => {
    const lease = await makeLease({ start: '2025-10-01', end: '2026-09-30' });
    await serveNotice(lease.id, '2026-11-15');
    await bill({ periods: ['2026-10-01', '2026-11-01'] });
    const invoices = await invoicesOf(lease.id);
    expect(invoices.map((i) => [i.period_start, i.covers_to, i.total_cents])).toEqual([
      ['2026-10-01', '2026-10-31', '900000'],
      ['2026-11-01', '2026-11-15', '450000'],
    ]);
  });

  it('the notice trim re-rates the last month a holdover tenant occupies instead of voiding it', async () => {
    const lease = await makeLease({ start: '2025-10-01', end: '2026-09-30' });
    await bill({ periods: ['2026-10-01', '2026-11-01'] });
    await serveNotice(lease.id, '2026-11-15');
    await db.withTransaction((run) => billing.trimInvoicesAfter(run, lease.id, '2026-11-15'));
    const invoices = await invoicesOf(lease.id);
    expect(invoices.map((i) => [i.period_start, i.status, i.total_cents])).toEqual([
      ['2026-10-01', 'issued', '900000'],
      ['2026-11-01', 'issued', '450000'],
    ]);
  });

  it('a holdover lease keeps billing until a signed renewal actually starts', async () => {
    const old = await makeLease({ start: '2025-10-01', end: '2026-09-30' });
    await makeLease({ start: '2026-12-01', end: '2027-11-30', status: 'scheduled', previous: old, signed: true });
    await bill({ periods: ['2026-11-01'] });
    expect((await invoicesOf(old.id)).map((i) => i.total_cents)).toEqual(['900000']);
  });
});

describe('the notice trim and money already paid (findings 3, 4)', () => {
  it('re-rates a fully paid next-month invoice and keeps the excess as the tenant’s credit', async () => {
    const lease = await makeLease({ start: '2026-01-01', end: '2026-12-31' });
    await bill({ periods: ['2026-11-01'] });
    const [november] = await invoicesOf(lease.id);
    await pay(lease.id, november!.id, 900000);
    await db.query(`update invoice set status = 'paid' where id = $1`, [november!.id]);

    const changed = await db.withTransaction((run) => billing.trimInvoicesAfter(run, lease.id, '2026-11-10'));
    expect(changed).toBe(1);
    const [after] = await invoicesOf(lease.id);
    expect(after).toMatchObject({ status: 'paid', total_cents: '300000', covers_to: '2026-11-10' });
    const [credit] = await db.query<{ cents: string }>(
      `select (coalesce(sum(p.amount_cents), 0) - i.total_cents)::text as cents
         from invoice i left join payment p on p.invoice_id = i.id where i.id = $1 group by i.id`,
      [november!.id],
    );
    expect(credit!.cents).toBe('600000');
  });

  it('compares payments against the new total, utilities included, not the rent alone', async () => {
    const lease = await makeLease({ start: '2026-01-01', end: '2026-12-31', rent: 850000 });
    await bill({ periods: ['2026-11-01'] });
    const [november] = await invoicesOf(lease.id);
    await db.query(
      `insert into invoice_line (invoice_id, kind, description, amount_cents) values ($1, 'utility', 'Water', 50000)`,
      [november!.id],
    );
    await db.query(`update invoice set total_cents = 900000, status = 'part_paid' where id = $1`, [november!.id]);
    await pay(lease.id, november!.id, 460000);

    await db.withTransaction((run) => billing.trimInvoicesAfter(run, lease.id, '2026-11-15'));
    const [after] = await invoicesOf(lease.id);
    // R8 500 for 15 of 30 days is R4 250, plus R500 water.
    expect(after).toMatchObject({ status: 'part_paid', total_cents: '475000' });
    expect(await owed(lease.id)).toBe(15000);
  });
});

describe('renewing a holding-over lease (finding 19)', () => {
  it('sets the start and the response date after the offer, not in the past', async () => {
    const { renewalTerms } = await import('../domain/renewal');
    const terms = renewalTerms({
      currentEndDate: dates.dateFromIso('2026-09-27'),
      currentRentCents: 900000,
      escalationPct: 0,
      depositHeldCents: 900000,
      offeredOn: dates.dateFromIso('2026-10-27'),
      respondDays: 14,
    });
    expect(dates.isoDate(terms.respondBy)).toBe('2026-11-10');
    expect(dates.isoDate(terms.newStartDate)).toBe('2026-12-01');
    expect(dates.isoDate(terms.newEndDate)).toBe('2027-11-30');
  });

  it('a tenant can accept a renewal offered after the end date has passed', async () => {
    const today = dates.sastToday();
    await db.query('update lease set end_date = $2 where id = $1', [LEASE, dates.addDaysIso(today, -30)]);
    const offer = await call('POST', `/leases/${LEASE}/renewal`, { body: {} });
    expect(offer.status).toBe(201);
    expect(offer.body.respondBy > today).toBe(true);
    expect(offer.body.newStartDate >= offer.body.respondBy).toBe(true);
    const accepted = await call('POST', `/renewals/${offer.body.id}/decision`, {
      sub: 'sub-tenant',
      groups: 'tenant',
      body: { decision: 'accept' },
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.startsOn).toBe(offer.body.newStartDate);
  });
});
