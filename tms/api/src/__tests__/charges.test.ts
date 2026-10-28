import { beforeAll, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invoiceStatus, monthsBetween } from '../domain/charge';
import { nextMonthStart, sastToday } from '../domain/dates';
import { zar } from '../domain/money';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const LEASE = '66666666-6666-6666-6666-666666666666';
const today = sastToday();
const thisMonth = today.slice(0, 7);
const nextMonth = nextMonthStart(`${thisMonth}-01`).slice(0, 7);
const monthsAgo = (n: number) => {
  const date = new Date(Date.UTC(Number(thisMonth.slice(0, 4)), Number(thisMonth.slice(5, 7)) - 1 - n, 1));
  return date.toISOString().slice(0, 7);
};

describe('charge rules', () => {
  it('counts months and settles invoice status from payments', () => {
    expect(monthsBetween('2026-10', '2027-01')).toBe(3);
    expect(invoiceStatus(0, 100)).toBe('issued');
    expect(invoiceStatus(50, 100)).toBe('part_paid');
    expect(invoiceStatus(100, 100)).toBe('paid');
    expect(invoiceStatus(0, 0)).toBe('void');
  });
});

type As = { sub: string; groups: string };
const OWNER: As = { sub: 'sub-landlord', groups: 'landlord' };
const TENANT: As = { sub: 'sub-tenant', groups: 'tenant' };
let call: (method: string, path: string, as: As, body?: unknown) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let runInvoices: (input?: { periods?: string[] }) => Promise<unknown>;
const invoiceFor = async (month: string) =>
  (await db.query<{ id: string; total: string; status: string; due_on: string }>(
    `select id, total_cents::text as total, status, due_on::text from invoice where lease_id = $1 and period_start = $2`,
    [LEASE, `${month}-01`],
  ))[0];

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://charges-${Date.now()}`;
  process.env.NODE_ENV = 'development';

  db = await import('../lib/db');
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  for (const file of all.filter((n) => !n.includes('seed'))) await db.execScript(read(file));
  for (const file of all.filter((n) => n.includes('seed'))) await db.execScript(read(file));
  ({ handler: runInvoices } = await import('../handlers/invoices-run'));
  await runInvoices({ periods: [`${thisMonth}-01`] });

  const { handler } = await import('../api');
  call = async (method, path, as, body) => {
    const event = {
      rawPath: path,
      headers: { 'content-type': 'application/json' },
      queryStringParameters: {},
      pathParameters: {},
      body: body === undefined ? undefined : JSON.stringify(body),
      requestContext: {
        http: { method, path, sourceIp: '10.60.0.1', userAgent: 'test' },
        authorizer: { jwt: { claims: { sub: as.sub, 'cognito:groups': `[${as.groups}]` } } },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
    const result = (await handler(event)) as { statusCode: number; body?: string };
    return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : null };
  };
}, 120_000);

const water = (period: string, amountCents = 35_000) => ({ period, kind: 'utility', description: 'Water', amountCents });

describe('adding charges to a lease', () => {
  it('holds a charge for next month until the run bills it, with the full amount in the email', async () => {
    const held = await call('POST', `/leases/${LEASE}/charges`, OWNER, water(nextMonth, 41_000));
    expect(held.body).toMatchObject({ billed: false, onMonth: nextMonth, description: 'Water' });
    const lease = await call('GET', `/leases/${LEASE}`, OWNER);
    expect(lease.body.charges.find((charge: any) => charge.id === held.body.id)).toMatchObject({ period: nextMonth, billed: false, amountCents: 41_000 });

    await runInvoices({ periods: [`${nextMonth}-01`] });
    const invoice = (await invoiceFor(nextMonth))!;
    const lines = await db.query<{ kind: string; amount_cents: string }>(
      'select kind, amount_cents::text from invoice_line where invoice_id = $1 order by kind', [invoice.id],
    );
    expect(lines.map((line) => line.kind)).toEqual(['rent', 'utility']);
    expect(Number(invoice.total)).toBe(lines.reduce((sum, line) => sum + Number(line.amount_cents), 0));
    expect(await db.query('select 1 from pending_charge')).toHaveLength(0);
    const [issued] = await db.query<{ subject: string }>(
      `select subject from notification where kind = 'invoice_issued' and dedupe_key like '%${nextMonth}%' and channel = 'email'`,
    );
    const spaces = (text: string) => text.replace(/\s/g, ' ');
    expect(spaces(issued!.subject)).toBe(spaces(`Rent for ${nextMonth}: ${zar(Number(invoice.total))}`));
  });

  it('puts a charge straight onto an invoice that is not due yet, and tells the tenant', async () => {
    const before = (await invoiceFor(nextMonth))!;
    const added = await call('POST', `/leases/${LEASE}/charges`, OWNER, { period: nextMonth, kind: 'other', description: 'Levy', amountCents: 65_000 });
    expect(added.body).toMatchObject({ billed: true, onMonth: nextMonth, totalCents: Number(before.total) + 65_000 });
    const [told] = await db.query<{ subject: string }>(`select subject from notification where kind = 'charge_added' and channel = 'email'`);
    expect(told!.subject).toMatch(/^Levy: .* added to your .* invoice$/);
  });

  it('moves a charge for a month already due onto the next invoice, named for its month', async () => {
    const added = await call('POST', `/leases/${LEASE}/charges`, OWNER, water(thisMonth, 35_000));
    expect(added.body).toMatchObject({ billed: true, onMonth: nextMonth });
    expect(added.body.description).toMatch(/^Water \(\w+ \d{4}\)$/);
    // Nothing went onto this month's invoice, so nothing new is overdue.
    const [line] = await db.query(`select 1 from invoice_line il join invoice i on i.id = il.invoice_id where i.period_start = $1 and il.kind = 'utility'`, [`${thisMonth}-01`]);
    expect(line).toBeUndefined();
  });

  it('only lets the landlord add them, and within the lease and three months ahead', async () => {
    expect((await call('POST', `/leases/${LEASE}/charges`, TENANT, water(thisMonth))).status).toBe(403);
    expect((await call('POST', `/leases/${LEASE}/charges`, OWNER, water('2001-01'))).status).toBe(400);
    expect((await call('POST', `/leases/${LEASE}/charges`, OWNER, water(monthsAgo(-4)))).status).toBe(400);
    expect((await call('POST', `/leases/${LEASE}/charges`, OWNER, { ...water(thisMonth), description: 'x' })).status).toBe(400);
  });

  it('refuses to remove a charge already paid, and removes one that is not', async () => {
    const invoice = (await invoiceFor(nextMonth))!;
    const [levy] = await db.query<{ id: string }>(`select id from invoice_line where invoice_id = $1 and description = 'Levy'`, [invoice.id]);
    await db.query(
      `insert into payment (lease_id, invoice_id, amount_cents, method, received_on, recorded_by) values ($1, $2, $3, 'eft', $4, 'sub-landlord')`,
      [LEASE, invoice.id, Number(invoice.total), today],
    );
    await db.query(`update invoice set status = 'paid' where id = $1`, [invoice.id]);
    expect((await call('DELETE', `/leases/${LEASE}/charges/${levy!.id}`, OWNER)).status).toBe(409);

    const key = await call('POST', `/leases/${LEASE}/charges`, OWNER, { period: nextMonth, kind: 'other', description: 'Replacement gate remote', amountCents: 25_000 });
    expect((await invoiceFor(nextMonth))!.status).toBe('part_paid');
    expect((await call('DELETE', `/leases/${LEASE}/charges/${key.body.id}`, OWNER)).status).toBe(200);
    expect((await invoiceFor(nextMonth))!.status).toBe('paid');
  });

  it('keeps the rent on an invoice that has no line items', async () => {
    // Invoices from before lines were stored carry only a total. Adding a charge must add to it.
    const later = monthsAgo(-2);
    await db.query(`insert into invoice (lease_id, period_start, due_on, total_cents, status) values ($1, $2, $2, 850000, 'issued')`, [LEASE, `${later}-01`]);
    const added = await call('POST', `/leases/${LEASE}/charges`, OWNER, water(later, 10_000));
    expect(added.body.totalCents).toBe(860_000);
    expect((await call('DELETE', `/leases/${LEASE}/charges/${added.body.id}`, OWNER)).status).toBe(200);
    expect((await invoiceFor(later))!.total).toBe('850000');
  });
});
