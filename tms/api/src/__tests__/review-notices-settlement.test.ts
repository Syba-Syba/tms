import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const LEASE = '66666666-6666-6666-6666-666666666666';

/** Notices and settlement: a penalty only on early cancellation, a lease past its end still
    needs notice, an end date cannot be set years out, a notice cannot sit beside an accepted
    renewal, an exit inspection cannot be backdated, and arrears from the deposit pay the rent. */
type Opts = { sub?: string; groups?: string; body?: unknown };
let call: (method: string, path: string, opts?: Opts) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let dates: typeof import('../domain/dates');
let domain: typeof import('../domain/termination');

const tenant: Opts = { sub: 'sub-tenant', groups: 'tenant' };

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://review-notices-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'tms-storage-'));
  process.env.KMS_DRIVER = 'local';

  db = await import('../lib/db');
  dates = await import('../domain/dates');
  domain = await import('../domain/termination');
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

const today = () => dates.sastToday();

// Each case starts from the seeded lease, live, with no notice, inspection or invoices.
beforeEach(async () => {
  await db.query('delete from termination where lease_id = $1', [LEASE]);
  await db.query('delete from inspection where lease_id = $1', [LEASE]);
  await db.query('delete from payment where lease_id = $1', [LEASE]);
  await db.query('delete from invoice where lease_id = $1', [LEASE]);
  await db.query('delete from renewal where lease_id = $1', [LEASE]);
  await db.query('delete from lease where previous_lease_id = $1', [LEASE]);
  await db.query(`delete from deposit_ledger where lease_id = $1 and entry_type <> 'received'`, [LEASE]);
  await db.query(
    `update lease set status = 'active', end_date = $2::date + 165 where id = $1`,
    [LEASE, today()],
  );
  await db.query(`update unit set status = 'occupied' where id = (select unit_id from lease where id = $1)`, [LEASE]);
});

/** A notice whose tenancy ended a few days ago, ready to settle. */
const endedNotice = async (daysAgo = 2) => {
  const [row] = await db.query<{ id: string }>(
    `insert into termination (lease_id, initiated_by, reason, notice_given_on, effective_on, notice_days)
     values ($1, 'tenant', 'early_tenant', $2::date - 30, $2::date - $3::int, 20) returning id`,
    [LEASE, today(), daysAgo],
  );
  return row!.id;
};

describe('a cancellation penalty', () => {
  it('is refused on a notice that is not an early cancellation', async () => {
    for (const body of [
      { initiatedBy: 'landlord', reason: 'end_of_term', penaltyCents: 300000 },
      { initiatedBy: 'landlord', reason: 'breach_by_tenant', penaltyCents: 300000 },
      { initiatedBy: 'tenant', reason: 'end_of_term', penaltyCents: 300000 },
    ]) {
      const response = await call('POST', `/leases/${LEASE}/termination`, { body });
      expect(response.status, body.reason).toBe(400);
    }
    const rows = await db.query('select 1 from termination where lease_id = $1', [LEASE]);
    expect(rows).toHaveLength(0);
  });

  it('is accepted on a tenant’s early cancellation the landlord records', async () => {
    const response = await call('POST', `/leases/${LEASE}/termination`, {
      body: { initiatedBy: 'tenant', reason: 'early_tenant', penaltyCents: 300000 },
    });
    expect(response.status).toBe(201);
  });
});

describe('a lease that has run past its end date', () => {
  it('still needs 20 business days’ notice for end_of_term, from either side', async () => {
    await db.query(`update lease set end_date = $2::date - 10 where id = $1`, [LEASE, today()]);
    const expected = dates.isoDate(domain.addBusinessDays(dates.dateFromIso(today()), 20));

    const tenantNotice = await call('POST', `/leases/${LEASE}/termination`, {
      ...tenant,
      body: { initiatedBy: 'tenant', reason: 'end_of_term' },
    });
    expect(tenantNotice.status).toBe(201);
    expect(tenantNotice.body.effectiveOn).toBe(expected);
    expect(tenantNotice.body.earliestLawful).toBe(expected);
    const [row] = await db.query<{ notice_days: number }>('select notice_days from termination where lease_id = $1', [LEASE]);
    expect(Number(row!.notice_days)).toBe(20);

    await db.query('delete from termination where lease_id = $1', [LEASE]);
    const sameDay = await call('POST', `/leases/${LEASE}/termination`, {
      body: { initiatedBy: 'landlord', reason: 'end_of_term', effectiveOn: today() },
    });
    expect(sameDay.status).toBe(400);
  });

  it('is unchanged for a lease still inside its term', () => {
    const end = dates.dateFromIso(dates.addDaysIso(today(), 90));
    expect(dates.isoDate(domain.earliestEffectiveDate('end_of_term', dates.dateFromIso(today()), end))).toBe(
      dates.isoDate(end),
    );
  });
});

describe('the end date a notice names', () => {
  it('cannot be set years past the lease end', async () => {
    const response = await call('POST', `/leases/${LEASE}/termination`, {
      ...tenant,
      body: { initiatedBy: 'tenant', reason: 'early_tenant', effectiveOn: '2035-01-01' },
    });
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/latest end date/);
  });

  it('may be any day up to the lease end', async () => {
    const [lease] = await db.query<{ end_date: string }>('select end_date::text from lease where id = $1', [LEASE]);
    const response = await call('POST', `/leases/${LEASE}/termination`, {
      ...tenant,
      body: { initiatedBy: 'tenant', reason: 'early_tenant', effectiveOn: lease!.end_date },
    });
    expect(response.status).toBe(201);
    expect(response.body.effectiveOn).toBe(lease!.end_date);
  });
});

describe('a notice beside a renewal', () => {
  const scheduleRenewal = async () => {
    const [current] = await db.query<{ application_id: string; unit_id: string; applicant_id: string }>(
      'select application_id, unit_id, applicant_id from lease where id = $1',
      [LEASE],
    );
    await db.query(
      `insert into lease (application_id, unit_id, applicant_id, start_date, end_date,
                          monthly_rent_cents, escalation_pct, deposit_cents, status, previous_lease_id)
       values ($1, $2, $3, $5::date + 166, $5::date + 531, 900000, 8, 900000, 'scheduled', $4)`,
      [current!.application_id, current!.unit_id, current!.applicant_id, LEASE, today()],
    );
  };

  it('is refused once a renewal has been accepted, and nothing is recorded', async () => {
    await scheduleRenewal();
    const response = await call('POST', `/leases/${LEASE}/termination`, {
      ...tenant,
      body: { initiatedBy: 'tenant', reason: 'early_tenant' },
    });
    expect(response.status).toBe(409);
    expect(response.body.error.message).toMatch(/renewal of this lease has been accepted/);
    const rows = await db.query('select 1 from termination where lease_id = $1', [LEASE]);
    expect(rows).toHaveLength(0);
  });

  it('lapses an open renewal offer, so it can no longer be accepted', async () => {
    const [offer] = await db.query<{ id: string }>(
      `insert into renewal (lease_id, respond_by, term_months, new_start_date, new_end_date, new_rent_cents)
       values ($1, $2::date + 20, 12, $2::date + 166, $2::date + 531, 900000) returning id`,
      [LEASE, today()],
    );
    const notice = await call('POST', `/leases/${LEASE}/termination`, {
      ...tenant,
      body: { initiatedBy: 'tenant', reason: 'early_tenant' },
    });
    expect(notice.status).toBe(201);
    const [row] = await db.query<{ status: string }>('select status from renewal where id = $1', [offer!.id]);
    expect(row!.status).toBe('lapsed');

    const accept = await call('POST', `/renewals/${offer!.id}/decision`, { ...tenant, body: { decision: 'accept' } });
    expect(accept.status).toBe(409);
  });
});

describe('the outgoing inspection', () => {
  it('cannot be booked for a day that has passed', async () => {
    await endedNotice(0);
    // Move the tenancy's last day to yesterday: yesterday is inside the 3 day window.
    await db.query(`update termination set effective_on = $2::date - 1 where lease_id = $1`, [LEASE, today()]);
    const backdated = await call('POST', `/leases/${LEASE}/inspections`, {
      body: { kind: 'outgoing', scheduledFor: dates.addDaysIso(today(), -1) },
    });
    expect(backdated.status).toBe(400);
    expect(backdated.body.error.message).toMatch(/past/);
  });

  const signedByLandlordOnly = async (createdDaysAgo: number, scheduledDaysAgo: number) => {
    const [inspection] = await db.query<{ id: string }>(
      `insert into inspection (lease_id, kind, status, scheduled_for, created_at)
       values ($1, 'outgoing', 'awaiting_signatures', $2::date - $3::int, now() - make_interval(days => $4::int))
       returning id`,
      [LEASE, today(), scheduledDaysAgo, createdDaysAgo],
    );
    await db.query(
      `insert into inspection_signature (inspection_id, party, signature_s3_key, pdf_sha256)
       values ($1, 'landlord', 'sig.png', $2)`,
      [inspection!.id, 'a'.repeat(64)],
    );
  };

  it('signed by the landlord alone does not count when it was created after its day', async () => {
    const terminationId = await endedNotice(2);
    await signedByLandlordOnly(0, 3);
    await db.query(
      `insert into deposit_deduction (termination_id, description, amount_cents) values ($1, 'Repaint', 200000)`,
      [terminationId],
    );
    const settled = await call('POST', `/terminations/${terminationId}/settle`, { body: {} });
    expect(settled.status).toBe(409);
    expect(settled.body.error.message).toMatch(/No outgoing inspection/);
  });

  it('signed by the landlord alone still counts when booked ahead and the tenant stayed away', async () => {
    const terminationId = await endedNotice(2);
    await signedByLandlordOnly(10, 3);
    await db.query(
      `insert into deposit_deduction (termination_id, description, amount_cents) values ($1, 'Repaint', 200000)`,
      [terminationId],
    );
    const settled = await call('POST', `/terminations/${terminationId}/settle`, { body: {} });
    expect(settled.status).toBe(200);
    expect(settled.body.refundRule).toBe('with_deductions');
  });
});

describe('arrears taken from the deposit', () => {
  it('pay the open invoices they cover, so the statement no longer shows them owed', async () => {
    const terminationId = await endedNotice(2);
    const [invoice] = await db.query<{ id: string }>(
      `insert into invoice (lease_id, period_start, due_on, total_cents)
       values ($1, $2::date - 120, $2::date - 120, 100000) returning id`,
      [LEASE, today()],
    );

    const settled = await call('POST', `/terminations/${terminationId}/settle`, { body: {} });
    expect(settled.status).toBe(200);
    expect(settled.body.arrearsCents).toBe(100000);

    const [after] = await db.query<{ status: string }>('select status from invoice where id = $1', [invoice!.id]);
    expect(after!.status).toBe('paid');
    const payments = await db.query<{ method: string; amount_cents: string }>(
      'select method, amount_cents::text from payment where invoice_id = $1',
      [invoice!.id],
    );
    expect(payments).toEqual([{ method: 'deposit', amount_cents: '100000' }]);

    const statement = await call('GET', `/leases/${LEASE}/statement`);
    expect(statement.body.balanceCents).toBe(0);
    expect(statement.body.ageing.d90plus).toBe(0);
  });

  it('net a rent credit against them, and move the credit onto the invoice it pays', async () => {
    const terminationId = await endedNotice(2);
    // August unpaid; September cut short by the notice to R4 250 but paid in full at R8 500.
    const [august] = await db.query<{ id: string }>(
      `insert into invoice (lease_id, period_start, due_on, total_cents)
       values ($1, $2::date - 60, $2::date - 60, 850000) returning id`,
      [LEASE, today()],
    );
    const [september] = await db.query<{ id: string }>(
      `insert into invoice (lease_id, period_start, due_on, total_cents, status)
       values ($1, $2::date - 30, $2::date - 30, 425000, 'paid') returning id`,
      [LEASE, today()],
    );
    await db.query(
      `insert into payment (lease_id, invoice_id, amount_cents, method, reference, received_on, recorded_by)
       values ($1, $2, 850000, 'eft', 'LSE-00101', $3::date - 31, 'sub-landlord')`,
      [LEASE, september!.id, today()],
    );

    const settled = await call('POST', `/terminations/${terminationId}/settle`, { body: {} });
    expect(settled.status).toBe(200);
    expect(settled.body.arrearsCents).toBe(425000);

    // August is paid: half by the moved credit, half from the deposit. Nothing is left owing,
    // so the arrears ladder has nothing to chase. Before, August stayed part paid at R4 250.
    const rows = await db.query<{ id: string; status: string; paid: string; total: string }>(
      `select i.id, i.status, i.total_cents::text as total,
              coalesce((select sum(amount_cents) from payment p where p.invoice_id = i.id), 0)::text as paid
         from invoice i where i.id = any($1::uuid[])`,
      [[august!.id, september!.id]],
    );
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    expect(byId[august!.id]).toMatchObject({ status: 'paid', paid: '850000' });
    expect(byId[september!.id]).toMatchObject({ status: 'paid', paid: '425000' });
    const [{ total }] = (await db.query<{ total: string }>(
      'select sum(amount_cents)::text as total from payment where lease_id = $1 and method <> $2', [LEASE, 'deposit'],
    )) as [{ total: string }];
    expect(total).toBe('850000');
    const statement = await call('GET', `/leases/${LEASE}/statement`);
    expect(statement.body.balanceCents).toBe(0);
  });

  it('part-pay the oldest invoice when the deposit does not cover them all', async () => {
    const terminationId = await endedNotice(2);
    const [older] = await db.query<{ id: string }>(
      `insert into invoice (lease_id, period_start, due_on, total_cents)
       values ($1, $2::date - 60, $2::date - 60, 800000) returning id`,
      [LEASE, today()],
    );
    const [newer] = await db.query<{ id: string }>(
      `insert into invoice (lease_id, period_start, due_on, total_cents)
       values ($1, $2::date - 30, $2::date - 30, 800000) returning id`,
      [LEASE, today()],
    );

    const settled = await call('POST', `/terminations/${terminationId}/settle`, { body: {} });
    expect(settled.status).toBe(200);
    // R8 500 held against R16 000 owed: the older invoice is paid, the newer one part paid.
    const rows = await db.query<{ id: string; status: string }>(
      'select id, status from invoice where id = any($1::uuid[])',
      [[older!.id, newer!.id]],
    );
    expect(Object.fromEntries(rows.map((row) => [row.id, row.status]))).toEqual({
      [older!.id]: 'paid',
      [newer!.id]: 'part_paid',
    });
    const statement = await call('GET', `/leases/${LEASE}/statement`);
    expect(statement.body.balanceCents).toBe(settled.body.tenantOwesCents);
  });

  it('give rent paid for days after the lease ended back to the tenant, outside the deposit', async () => {
    const terminationId = await endedNotice(2);
    // A month paid in full on the 25th, then cut short by the notice: R4 000 billed, R9 000 paid.
    const [invoice] = await db.query<{ id: string }>(
      `insert into invoice (lease_id, period_start, due_on, total_cents, status)
       values ($1, $2::date - 30, $2::date - 30, 400000, 'paid') returning id`,
      [LEASE, today()],
    );
    await db.query(
      `insert into payment (lease_id, invoice_id, amount_cents, method, reference, received_on, recorded_by)
       values ($1, $2, 900000, 'eft', 'rent', $3::date - 31, 'sub-landlord')`,
      [LEASE, invoice!.id, today()],
    );

    const settled = await call('POST', `/terminations/${terminationId}/settle`, { body: {} });
    expect(settled.status).toBe(200);
    expect(settled.body.arrearsCents).toBe(0);
    expect(settled.body.rentCreditCents).toBe(500000);
    expect(settled.body.refundCents).toBe(settled.body.heldCents + 500000);

    // The deposit ledger still balances to zero: only the deposit's share was paid out of it.
    const [ledger] = await db.query<{ balance: string }>(
      `select coalesce(sum(case when entry_type in ('received', 'interest') then amount_cents else -amount_cents end), 0)::text as balance
         from deposit_ledger where lease_id = $1`,
      [LEASE],
    );
    expect(Number(ledger!.balance)).toBe(0);
  });

  it('net a rent credit against arrears before touching the deposit', async () => {
    const terminationId = await endedNotice(2);
    const [paid] = await db.query<{ id: string }>(
      `insert into invoice (lease_id, period_start, due_on, total_cents, status)
       values ($1, $2::date - 30, $2::date - 30, 400000, 'paid') returning id`,
      [LEASE, today()],
    );
    await db.query(
      `insert into payment (lease_id, invoice_id, amount_cents, method, reference, received_on, recorded_by)
       values ($1, $2, 600000, 'eft', 'rent', $3::date - 31, 'sub-landlord')`,
      [LEASE, paid!.id, today()],
    );
    await db.query(
      `insert into invoice (lease_id, period_start, due_on, total_cents)
       values ($1, $2::date - 60, $2::date - 60, 300000)`,
      [LEASE, today()],
    );

    const settled = await call('POST', `/terminations/${terminationId}/settle`, { body: {} });
    expect(settled.status).toBe(200);
    // R3 000 owed less R2 000 overpaid leaves R1 000 for the deposit to cover.
    expect(settled.body.arrearsCents).toBe(100000);
    expect(settled.body.rentCreditCents).toBe(0);
  });
});
