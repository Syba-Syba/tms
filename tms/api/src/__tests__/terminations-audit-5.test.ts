import { beforeAll, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const PROPERTY = '22222222-2222-2222-2222-222222222222';

/** Terminations, fifth audit: landlord-recorded notices wait for the tenant, penalties are
    capped, a confirmed mutual notice is not undone alone, and settlement takes the lease lock,
    re-checks its figures, waits for pending slips, books any shortfall and dates in SAST. */
type Opts = { sub?: string; groups?: string; body?: unknown; query?: Record<string, string> };
let call: (method: string, path: string, opts?: Opts) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let dates: typeof import('../domain/dates');

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://terminations-audit-5-${Date.now()}`;
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

describe('items 7, 14, 0 and 50: a tenant notice the landlord records waits for the tenant', () => {
  it('dated today, with a penalty, it waits; the tenant is told the penalty; the landlord may withdraw it', async () => {
    const tenantSub = `sub-${randomUUID()}`;
    const { lease } = await leaseFor({ start: plus(-100), end: plus(265), tenantSub });
    const served = await call('POST', `/leases/${lease}/termination`, {
      body: { initiatedBy: 'tenant', reason: 'early_tenant', penaltyCents: 300000 },
    });
    expect(served.status).toBe(201);
    expect(served.body.awaitingTenant).toBe(true);
    const { zar } = await import('../domain/money');
    const [asked] = await sentTo(lease, 'notice_confirm_requested');
    expect(asked?.recipient_sub).toBe(tenantSub);
    expect(asked!.body).toContain(zar(300000));
    const got = await call('GET', `/leases/${lease}`, asTenant(tenantSub));
    expect(got.body.termination).toMatchObject({ initiatedBy: 'tenant', awaitingTenant: true });
    // Item 50: the landlord's own entry, not yet confirmed, can be undone by the landlord.
    expect((await call('POST', `/terminations/${served.body.id}/withdraw`)).status).toBe(200);
  });

  it('an end-of-term notice the landlord records for the tenant also waits', async () => {
    const tenantSub = `sub-${randomUUID()}`;
    const { lease } = await leaseFor({ start: plus(-350), end: plus(14), tenantSub });
    const served = await call('POST', `/leases/${lease}/termination`, { body: { initiatedBy: 'tenant', reason: 'end_of_term' } });
    expect(served.status).toBe(201);
    expect(served.body.awaitingTenant).toBe(true);
  });

  it('a tenant serving their own notice does not wait for anyone', async () => {
    const tenantSub = `sub-${randomUUID()}`;
    const { lease } = await leaseFor({ start: plus(-100), end: plus(265), tenantSub });
    const served = await call('POST', `/leases/${lease}/termination`, {
      ...asTenant(tenantSub), body: { initiatedBy: 'tenant', reason: 'early_tenant' },
    });
    expect(served.status).toBe(201);
    expect(served.body.awaitingTenant).toBe(false);
  });
});

describe('item 0: the cancellation penalty is capped', () => {
  it('at one month’s rent', async () => {
    const tenantSub = `sub-${randomUUID()}`;
    const { lease } = await leaseFor({ start: plus(-100), end: plus(265), tenantSub });
    const over = await call('POST', `/leases/${lease}/termination`, {
      body: { initiatedBy: 'tenant', reason: 'early_tenant', penaltyCents: 5_000_000 },
    });
    expect(over.status).toBe(400);
    expect(over.body.error.message).toMatch(/penalty/i);
    const ok = await call('POST', `/leases/${lease}/termination`, {
      body: { initiatedBy: 'tenant', reason: 'early_tenant', penaltyCents: 700000 },
    });
    expect(ok.status).toBe(201);
  });

  it('at the rent for the unexpired term when that is less', async () => {
    const tenantSub = `sub-${randomUUID()}`;
    const { lease } = await leaseFor({ start: plus(-300), end: plus(60), tenantSub });
    // 15 days left of the term: R7 000 × 15 × 12 / 365 = R3 452.05.
    const over = await call('POST', `/leases/${lease}/termination`, {
      body: { initiatedBy: 'tenant', reason: 'early_tenant', effectiveOn: plus(45), penaltyCents: 400000 },
    });
    expect(over.status).toBe(400);
    const ok = await call('POST', `/leases/${lease}/termination`, {
      body: { initiatedBy: 'tenant', reason: 'early_tenant', effectiveOn: plus(45), penaltyCents: 300000 },
    });
    expect(ok.status).toBe(201);
  });

  it('at the escalated rent, not the starting rent', async () => {
    const tenantSub = `sub-${randomUUID()}`;
    const { lease } = await leaseFor({ start: plus(-400), end: plus(330), tenantSub });
    await db.query('update lease set escalation_pct = 10 where id = $1', [lease]);
    // A year in, the rent is R7 700, so a R7 700 penalty is one month's rent.
    const ok = await call('POST', `/leases/${lease}/termination`, {
      body: { initiatedBy: 'tenant', reason: 'early_tenant', penaltyCents: 770000 },
    });
    expect(ok.status).toBe(201);
  });
});

describe('item 8: a notice that needs the tenant’s confirmation needs a tenant who can give it', () => {
  it('is refused for a tenant with no account, with a pointer to the invite', async () => {
    const { lease } = await leaseFor({ start: plus(-100), end: plus(265) });
    const tenantNotice = await call('POST', `/leases/${lease}/termination`, { body: { initiatedBy: 'tenant', reason: 'early_tenant' } });
    expect(tenantNotice.status).toBe(409);
    expect(tenantNotice.body.error.message).toMatch(/invite/i);
    const mutual = await call('POST', `/leases/${lease}/termination`, { body: { initiatedBy: 'mutual', reason: 'mutual' } });
    expect(mutual.status).toBe(409);
    // The landlord's own notice needs nobody's confirmation.
    const own = await call('POST', `/leases/${lease}/termination`, { body: { initiatedBy: 'landlord', reason: 'breach_by_tenant' } });
    expect(own.status).toBe(201);
  });
});

describe('item 9: a confirmed mutual notice is not undone by one side', () => {
  it('refuses the landlord and the tenant once the tenant has confirmed', async () => {
    const tenantSub = `sub-${randomUUID()}`;
    const { lease } = await leaseFor({ start: plus(-100), end: plus(265), tenantSub });
    const served = await call('POST', `/leases/${lease}/termination`, {
      body: { initiatedBy: 'mutual', reason: 'mutual', effectiveOn: plus(20) },
    });
    expect(served.status).toBe(201);
    expect((await call('POST', `/terminations/${served.body.id}/confirm`, asTenant(tenantSub))).status).toBe(200);
    const byLandlord = await call('POST', `/terminations/${served.body.id}/withdraw`);
    expect(byLandlord.status).toBe(409);
    expect(byLandlord.body.error.message).toMatch(/Both parties agreed/);
    expect((await call('POST', `/terminations/${served.body.id}/withdraw`, asTenant(tenantSub))).status).toBe(409);
  });

  it('the tenant may still refuse one that is awaiting them', async () => {
    const tenantSub = `sub-${randomUUID()}`;
    const { lease } = await leaseFor({ start: plus(-100), end: plus(265), tenantSub });
    const served = await call('POST', `/leases/${lease}/termination`, {
      body: { initiatedBy: 'mutual', reason: 'mutual', effectiveOn: plus(20) },
    });
    expect((await call('POST', `/terminations/${served.body.id}/withdraw`, asTenant(tenantSub))).status).toBe(200);
  });
});

describe('item 13: a landlord’s end-of-term notice is not served more than 80 business days early', () => {
  it('refuses one served too early, and names the first day it can be served', async () => {
    const { lease } = await leaseFor({ start: plus(-100), end: plus(200) });
    const early = await call('POST', `/leases/${lease}/termination`, { body: { initiatedBy: 'landlord', reason: 'end_of_term' } });
    expect(early.status).toBe(400);
    const from = /from (\d{4}-\d{2}-\d{2})/.exec(early.body.error.message)?.[1];
    expect(from).toBeDefined();
    const { businessDaysBetween } = await import('../domain/termination');
    const end = dates.dateFromIso(plus(200));
    expect(businessDaysBetween(dates.dateFromIso(from!), end)).toBeLessThanOrEqual(80);
    expect(businessDaysBetween(dates.dateFromIso(dates.addDaysIso(from!, -1)), end)).toBeGreaterThan(80);
  });

  it('accepts one inside the window', async () => {
    const { lease } = await leaseFor({ start: plus(-100), end: plus(90) });
    const served = await call('POST', `/leases/${lease}/termination`, { body: { initiatedBy: 'landlord', reason: 'end_of_term' } });
    expect(served.status).toBe(201);
    expect(served.body.effectiveOn).toBe(plus(90));
  });
});

describe('item 1: settlement waits for pending payment slips', () => {
  it('names them in the preview and refuses to settle', async () => {
    const { lease, terminationId } = await settleable();
    await db.query(
      `insert into payment_proof (lease_id, target, amount_cents, paid_on, s3_key, content_type, size_bytes, status, submitted_by)
       values ($1, 'invoice', 900000, $2, $3, 'image/png', 10, 'pending', 'sub-tenant')`,
      [lease, plus(-3), `proofs/${randomUUID()}.png`],
    );
    const preview = await call('GET', `/terminations/${terminationId}/settlement`);
    expect(preview.body.blocker).toMatch(/payment slips/);
    const settled = await call('POST', `/terminations/${terminationId}/settle`, { body: {} });
    expect(settled.status).toBe(409);
    expect(settled.body.error.message).toMatch(/payment slips/);
  });

  it('catches a slip sent while the statement was prepared', async () => {
    const { lease, terminationId } = await settleable();
    const settled = await duringRender(
      () => db.query(
        `insert into payment_proof (lease_id, target, amount_cents, paid_on, s3_key, content_type, size_bytes, status, submitted_by)
         values ($1, 'deposit', 100000, $2, $3, 'image/png', 10, 'pending', 'sub-tenant')`,
        [lease, plus(-3), `proofs/${randomUUID()}.png`],
      ),
      () => call('POST', `/terminations/${terminationId}/settle`, { body: {} }),
    ) as { status: number; body: any };
    expect(settled.status).toBe(409);
    expect(settled.body.error.message).toMatch(/payment slips/);
  });
});

describe('item 2: what the tenant owes beyond the deposit is billed', () => {
  it('puts the shortfall on an invoice, open for payment', async () => {
    const { lease, terminationId } = await settleable({ depositCents: 300000 });
    const [invoice] = await db.query<{ id: string }>(
      `insert into invoice (lease_id, period_start, due_on, total_cents, status) values ($1, $2, $2, 700000, 'paid') returning id`,
      [lease, `${plus(-40).slice(0, 7)}-01`],
    );
    await db.query(
      `insert into payment (lease_id, invoice_id, amount_cents, method, reference, received_on, recorded_by)
       values ($1, $2, 700000, 'eft', 'rent', $3, 'sub-landlord')`,
      [lease, invoice!.id, plus(-40)],
    );
    await deduct(terminationId, 'Replace carpet', 500000);
    const settled = await call('POST', `/terminations/${terminationId}/settle`, { body: { restoredOn: plus(-1) } });
    expect(settled.status).toBe(200);
    expect(settled.body.tenantOwesCents).toBe(200000);
    const lines = await db.query<{ amount_cents: string; status: string; total_cents: string }>(
      `select il.amount_cents, i.status, i.total_cents from invoice_line il join invoice i on i.id = il.invoice_id
        where i.lease_id = $1 and il.kind = 'other'`,
      [lease],
    );
    expect(lines.map((l) => Number(l.amount_cents))).toEqual([200000]);
    expect(lines[0]!.status).toBe('part_paid');
    expect(Number(lines[0]!.total_cents)).toBe(900000);
  });

  it('keeps the shortfall owing when the latest invoice holds rent credit', async () => {
    // Deposit R3 000 and R2 000 of rent credit against a R6 000 deduction: R1 000 still owed.
    const { lease, terminationId } = await settleable({ depositCents: 300000 });
    const [invoice] = await db.query<{ id: string }>(
      `insert into invoice (lease_id, period_start, due_on, total_cents, status) values ($1, $2, $2, 700000, 'paid') returning id`,
      [lease, `${plus(-20).slice(0, 7)}-01`],
    );
    await db.query(
      `insert into payment (lease_id, invoice_id, amount_cents, method, reference, received_on, recorded_by)
       values ($1, $2, 900000, 'eft', 'rent', $3, 'sub-landlord')`,
      [lease, invoice!.id, plus(-20)],
    );
    await deduct(terminationId, 'Replace carpet', 600000);
    const settled = await call('POST', `/terminations/${terminationId}/settle`, { body: { restoredOn: plus(-1) } });
    expect(settled.status).toBe(200);
    expect(settled.body.tenantOwesCents).toBe(100000);
    const [row] = await db.query<{ total_cents: string; status: string; paid: string }>(
      `select i.total_cents, i.status,
              coalesce((select sum(amount_cents) from payment p where p.invoice_id = i.id), 0)::text as paid
         from invoice i where i.id = $1`,
      [invoice!.id],
    );
    expect(Number(row!.total_cents)).toBe(800000);
    expect(Number(row!.total_cents) - Number(row!.paid)).toBe(100000);
    expect(row!.status).toBe('part_paid');
  });

  it('creates an invoice when the lease has none', async () => {
    const { lease, terminationId } = await settleable({ depositCents: 100000 });
    await deduct(terminationId, 'Replace carpet', 250000);
    const settled = await call('POST', `/terminations/${terminationId}/settle`, { body: { restoredOn: plus(-1) } });
    expect(settled.status).toBe(200);
    const [row] = await db.query<{ total_cents: string; status: string }>(
      `select total_cents, status from invoice where lease_id = $1`, [lease]);
    expect(Number(row!.total_cents)).toBe(150000);
    expect(row!.status).toBe('issued');
  });
});

describe('item 6: settlement ledger entries are dated in SAST', () => {
  it('uses the SAST date even when the database clock says otherwise', async () => {
    const { lease, terminationId } = await settleable();
    await deduct(terminationId, 'Replace carpet', 100000);
    // A zone on the other side of the date line from SAST right now, so current_date differs.
    const sastHour = Number(new Date(Date.now() + 2 * 3600_000).toISOString().slice(11, 13));
    await db.query(`set timezone to '${sastHour < 12 ? 'Etc/GMT+12' : 'Etc/GMT-14'}'`);
    try {
      const settled = await call('POST', `/terminations/${terminationId}/settle`, { body: { restoredOn: plus(-1) } });
      expect(settled.status).toBe(200);
    } finally {
      await db.query('reset timezone');
    }
    const rows = await db.query<{ occurred_on: string }>(
      `select occurred_on::text from deposit_ledger where lease_id = $1 and entry_type in ('deduction', 'refund')`, [lease]);
    expect(rows.length).toBe(2);
    for (const row of rows) expect(row.occurred_on).toBe(today());
  });
});

describe('item 11: settlement closes tickets left on the lease a renewal replaced', () => {
  it('cancels an open ticket on the previous lease in the chain', async () => {
    const first = await leaseFor({ start: plus(-700), end: plus(-301), status: 'terminated' });
    const [ticket] = await db.query<{ id: string }>(
      `insert into ticket (lease_id, category, severity, title, description, target_by, created_by)
       values ($1, 'plumbing', 'routine', 'Leaking tap', 'Kitchen tap drips', now() - interval '30 days', 'sub-tenant') returning id`,
      [first.lease],
    );
    const { terminationId } = await settleable({ previous: first.lease, unit: first.unit, applicant: first.applicant });
    expect((await call('POST', `/terminations/${terminationId}/settle`, { body: {} })).status).toBe(200);
    const [row] = await db.query<{ status: string }>('select status from ticket where id = $1', [ticket!.id]);
    expect(row!.status).toBe('cancelled');
  });
});

describe('items 12 and 51: deductions are re-checked inside the settle transaction', () => {
  it('refuses when a deduction is added while the statement renders', async () => {
    const { lease, terminationId } = await settleable();
    await deduct(terminationId, 'Replace carpet', 100000);
    const settled = await duringRender(
      () => deduct(terminationId, 'Repaint lounge', 50000),
      () => call('POST', `/terminations/${terminationId}/settle`, { body: { restoredOn: plus(-1) } }),
    ) as { status: number; body: any };
    expect(settled.status).toBe(409);
    expect(settled.body.error.message).toMatch(/deductions changed/);
    const [ledger] = await db.query<{ n: string }>(
      `select count(*)::text as n from deposit_ledger where lease_id = $1 and entry_type = 'deduction'`, [lease]);
    expect(ledger!.n).toBe('0');
  });

  it('refuses when a deduction is removed while the statement renders', async () => {
    const { terminationId } = await settleable();
    await deduct(terminationId, 'Replace carpet', 100000);
    const settled = await duringRender(
      () => db.query('delete from deposit_deduction where termination_id = $1', [terminationId]),
      () => call('POST', `/terminations/${terminationId}/settle`, { body: { restoredOn: plus(-1) } }),
    ) as { status: number; body: any };
    expect(settled.status).toBe(409);
  });

  it('refuses when the notice comes to need the tenant’s confirmation meanwhile', async () => {
    const { terminationId } = await settleable();
    const settled = await duringRender(
      () => db.query('update termination set needs_tenant_confirmation = true where id = $1', [terminationId]),
      () => call('POST', `/terminations/${terminationId}/settle`, { body: {} }),
    ) as { status: number; body: any };
    expect(settled.status).toBe(409);
  });
});

describe('items 49 and 4: settlement takes the lease lock first', () => {
  // PGlite is one connection, so lock order cannot be raced here; the order is checked in the
  // source, and the effect (a deposit landing mid-render is caught) end to end.
  it('locks the lease before the termination and the invoices', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../handlers/terminations-settle.ts'), 'utf8');
    const tx = source.slice(source.indexOf('await withTransaction(async (run) => {'));
    const lockAt = tx.indexOf('await lockLease(run, context.lease_id)');
    expect(lockAt).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(tx.indexOf('from termination t'));
    expect(lockAt).toBeLessThan(tx.indexOf('readBalances(run'));
  });

  it('refuses when deposit money lands while the statement renders', async () => {
    const { lease, terminationId } = await settleable();
    const settled = await duringRender(
      () => deposit(lease, 100000),
      () => call('POST', `/terminations/${terminationId}/settle`, { body: {} }),
    ) as { status: number; body: any };
    expect(settled.status).toBe(409);
  });
});
