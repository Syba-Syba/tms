import { beforeAll, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lastAnniversary, parseTenancyCsv, rowProblems, type ImportRow } from '../domain/tenancy-import';
import { addDaysIso, nextMonthStart, sastToday } from '../domain/dates';
import { PRIVACY_VERSION } from '../domain/privacy';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const today = sastToday();
const monthStart = `${today.slice(0, 7)}-01`;
const lastMonth = (() => {
  const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`;
})();
const yearsAgo = (years: number, monthDay: string) => `${Number(today.slice(0, 4)) - years}-${monthDay}`;

describe('import rules', () => {
  const base: ImportRow = {
    property: 'Kruis Court', unit: 'A2', firstName: 'Ayanda', lastName: 'Mokoena', email: 'a@example.co.za',
    phone: '+27821112222', startDate: '2024-03-01', endDate: '2026-02-28', monthlyRentCents: 600000,
    escalationPct: 0, depositHeldCents: 0, currentMonthPaid: true, arrearsCents: 0,
  };

  it('counts escalation from the last anniversary, never before the start', () => {
    expect(lastAnniversary('2024-03-01', '2026-10-28')).toBe('2026-03-01');
    expect(lastAnniversary('2024-11-15', '2026-10-28')).toBe('2025-11-15');
    expect(lastAnniversary('2026-09-01', '2026-10-28')).toBe('2026-09-01');
    expect(lastAnniversary('2024-02-29', '2025-03-10')).toBe('2025-02-28');
  });

  it('refuses a lease that has not started, and arrears without a date or from this month', () => {
    expect(rowProblems({ ...base, startDate: '2999-01-01', endDate: '2999-12-31' }, today)).toContain(
      'This lease has not started yet. Add it through an application instead.',
    );
    expect(rowProblems({ ...base, arrearsCents: 5000 }, today)).toContain('Say since when the arrears are owed.');
    expect(rowProblems({ ...base, arrearsCents: 5000, arrearsSince: monthStart }, today)[0]).toMatch(/before this month/);
    expect(rowProblems(base, today)).toEqual([]);
  });

  it('reads a spreadsheet with its own column names, rand amounts and day-first dates', () => {
    const { rows, missingColumns } = parseTenancyCsv(
      'Building;Flat;Name;Surname;E-mail;Cell;Start;End;Monthly rent;Deposit held;Paid;Owing;Owing since\n' +
        'Kruis Court;A2;Ayanda;Mokoena;a@example.co.za;082 111 2222;01/03/2024;28/02/2027;R6 000,00;R6 000;ja;1500;01/08/2026\n' +
        'Kruis Court;B1;Bo;Zulu;b@example.co.za;0821113333;someday;2027-01-01;lots;0;maybe;0;\n',
    );
    expect(missingColumns).toEqual([]);
    expect(rows[0]).toMatchObject({
      line: 2,
      problems: [],
      input: {
        property: 'Kruis Court', unit: 'A2', startDate: '2024-03-01', endDate: '2027-02-28',
        monthlyRentCents: 600000, depositHeldCents: 600000, currentMonthPaid: true, arrearsCents: 150000,
        arrearsSince: '2026-08-01',
      },
    });
    expect(rows[1]!.problems).toHaveLength(3);
    expect(parseTenancyCsv('Name,Email\nA,b@c.d').missingColumns).toContain('property');
  });
});

type As = { sub: string; groups: string };
const LANDLORD: As = { sub: 'sub-landlord', groups: 'landlord' };
const NOBODY: As = { sub: 'anonymous', groups: 'tenant' };
let call: (method: string, path: string, as: As, body?: unknown) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let runInvoices: (input?: { periods?: string[] }) => Promise<unknown>;

const tokenFor = async (email: string) => {
  const [row] = await db.query<{ body: string }>(
    `select body from notification where recipient_to = $1 and kind = 'tenant_invite' order by created_at desc limit 1`,
    [email],
  );
  return row?.body.match(/token=([A-Za-z0-9_-]+)/)?.[1];
};

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://tenancy-import-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.AUTH_DRIVER = 'local';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'tms-import-'));
  process.env.KMS_DRIVER = 'local';

  db = await import('../lib/db');
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  for (const file of all.filter((n) => !n.includes('seed'))) await db.execScript(read(file));
  for (const file of all.filter((n) => n.includes('seed'))) await db.execScript(read(file));

  ({ handler: runInvoices } = await import('../handlers/invoices-run'));
  const { handler } = await import('../api');
  let ip = 0;
  call = async (method, fullPath, as, body) => {
    const [path = fullPath, search] = fullPath.split('?');
    const event = {
      rawPath: path,
      headers: { 'content-type': 'application/json' },
      queryStringParameters: Object.fromEntries(new URLSearchParams(search ?? '')),
      pathParameters: {},
      body: body === undefined ? undefined : JSON.stringify(body),
      requestContext: {
        http: { method, path, sourceIp: `10.30.0.${(ip++ % 250) + 1}`, userAgent: 'test' },
        authorizer: { jwt: { claims: { sub: as.sub, 'cognito:groups': `[${as.groups}]` } } },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
    const result = (await handler(event)) as { statusCode: number; body?: string };
    return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : null };
  };
}, 120_000);

const csv = (...rows: string[]) =>
  ['Property,Unit,Bedrooms,Bathrooms,First name,Last name,Email,Phone,ID number,Lease start,Lease end,Rent,Escalation,Deposit held,Paid this month,Arrears,Arrears since', ...rows].join('\n');

describe('importing a spreadsheet', () => {
  const a2 = `Kruis Court,A2,,,Ayanda,Mokoena,ayanda.m@example.co.za,082 111 2222,9001015009086,${yearsAgo(2, '01-01')},${yearsAgo(-1, '12-31')},10000,10,6200,yes,,`;
  const c9 = `Kruis Court,C9,2,1,Bongi,Zulu,bongi@example.co.za,082 111 3333,,${lastMonth},${yearsAgo(-1, '06-30')},7000,,7000,no,3500,${lastMonth}`;
  let leases: string[] = [];

  it('reports every problem by line and writes nothing while any remain', async () => {
    const occupied = `Kruis Court,A1,,,Busy,Tenant,busy@example.co.za,082 111 4444,,2024-01-01,2027-01-01,8500,,0,yes,,`;
    const nowhere = `Nowhere Court,X1,,,Lost,Tenant,lost@example.co.za,082 111 5555,,2024-01-01,2027-01-01,8500,,0,yes,,`;
    const dry = await call('POST', '/leases/import', LANDLORD, { csv: csv(a2, c9, occupied, nowhere), dryRun: false });
    expect(dry.status).toBe(200);
    expect(dry.body.imported).toBe(0);
    expect(dry.body.failed).toBe(2);
    expect(dry.body.results[1]).toMatchObject({ line: 3, newUnit: true, problems: [] });
    expect(dry.body.results[2].problems[0]).toBe('Kruis Court A1 already has a lease.');
    expect(dry.body.results[3].problems[0]).toMatch(/no property called "Nowhere Court"/);
    expect(await db.query(`select 1 from lease where source = 'import'`)).toHaveLength(0);
  });

  it('imports all rows, with this month billed once and arrears dated when they fell due', async () => {
    const preview = await call('POST', '/leases/import', LANDLORD, { csv: csv(a2, c9), dryRun: true });
    expect(preview.body).toMatchObject({ imported: 0, failed: 0 });
    const done = await call('POST', '/leases/import', LANDLORD, { csv: csv(a2, c9), dryRun: false, invite: true });
    expect(done.status).toBe(201);
    expect(done.body.imported).toBe(2);
    leases = done.body.leaseIds;

    const [first] = await db.query<{ status: string; escalates_from: string; unit_status: string; id_last4: string }>(
      `select l.status, l.escalates_from::text, u.status as unit_status, a.id_number_last4 as id_last4
         from lease l join unit u on u.id = l.unit_id join applicant a on a.id = l.applicant_id where l.id = $1`,
      [leases[0]],
    );
    expect(first).toMatchObject({ status: 'active', escalates_from: yearsAgo(0, '01-01'), unit_status: 'occupied', id_last4: '9086' });

    // R10 000 is today's rent: two anniversaries have passed, and it is not escalated again.
    const invoices = await db.query<{ lease_id: string; period_start: string; due_on: string; total_cents: string; status: string }>(
      `select lease_id, period_start::text, due_on::text, total_cents::text, status from invoice where lease_id = any($1::uuid[])
        order by lease_id, period_start`,
      [leases],
    );
    expect(invoices.filter((row) => row.lease_id === leases[0])).toEqual([
      { lease_id: leases[0], period_start: monthStart, due_on: monthStart, total_cents: '1000000', status: 'paid' },
    ]);
    expect(invoices.filter((row) => row.lease_id === leases[1])).toEqual([
      { lease_id: leases[1], period_start: lastMonth, due_on: lastMonth, total_cents: '350000', status: 'issued' },
      { lease_id: leases[1], period_start: monthStart, due_on: monthStart, total_cents: '700000', status: 'issued' },
    ]);
    const [deposit] = await db.query<{ amount_cents: string }>(
      `select amount_cents::text from deposit_ledger where lease_id = $1 and entry_type = 'received'`,
      [leases[1]],
    );
    expect(deposit!.amount_cents).toBe('700000');

    await runInvoices({ periods: [monthStart] });
    expect(await db.query('select 1 from invoice where lease_id = any($1::uuid[])', [leases])).toHaveLength(3);
  });

  it('escalates on the next anniversary, from the rent as it stands', async () => {
    const anniversary = yearsAgo(-1, '01-01');
    await runInvoices({ periods: [anniversary] });
    const [row] = await db.query<{ total_cents: string }>(
      'select total_cents::text from invoice where lease_id = $1 and period_start = $2',
      [leases[0], anniversary],
    );
    expect(row!.total_cents).toBe('1100000');
  });

  it('keeps imported tenancies out of the applications queue', async () => {
    const queue = await call('GET', '/applications?status=all', LANDLORD);
    expect(queue.body.items.some((item: any) => item.leaseId === leases[0])).toBe(false);
    const lease = await call('GET', `/leases/${leases[0]}`, LANDLORD);
    expect(lease.body).toMatchObject({ source: 'import', tenantHasAccount: false });
    expect(lease.body.tenantInviteSentAt).toBeTruthy();
  });

  it('refuses another landlord\'s unit by id', async () => {
    await db.query(
      `insert into landlord (trading_name, email, phone, cognito_sub) values ('Other', 'o@example.co.za', '0820000000', 'sub-other')`,
    );
    const theirs = await call('POST', '/leases/import', { sub: 'sub-other', groups: 'landlord' }, {
      rows: [{ unitId: '33333333-3333-3333-3333-333333333335', firstName: 'X', lastName: 'Y', email: 'x@example.co.za',
        phone: '0821119999', startDate: '2024-01-01', endDate: '2027-01-01', monthlyRentCents: 100, currentMonthPaid: true }],
      dryRun: true,
    });
    expect(theirs.body.results[0].problems).toEqual(['That unit was not found.']);
  });
});

describe('the tenant taking the lease into the app', () => {
  it('chooses a password from the emailed link and sees their lease', async () => {
    const token = await tokenFor('ayanda.m@example.co.za');
    const look = await call('POST', '/invites/lookup', NOBODY, { token });
    expect(look.body).toMatchObject({ kind: 'tenant', landlord: 'Mokoena Properties', unit: 'Kruis Court A2', hasAccount: false });
    const joined = await call('POST', '/invites/accept', NOBODY, { token, password: 'tenant-password', consentVersion: PRIVACY_VERSION });
    expect(joined.status).toBe(201);
    expect(joined.body.user).toMatchObject({ role: 'tenant', name: 'Ayanda Mokoena' });
    const leases = await call('GET', '/leases', { sub: joined.body.user.sub, groups: 'tenant' });
    expect(leases.body.items).toHaveLength(1);
    expect((await call('POST', '/invites/accept', NOBODY, { token, password: 'again-pass', consentVersion: PRIVACY_VERSION })).status).toBe(404);
  });

  it('joins an existing account only with that account\'s password', async () => {
    const rows = [{
      property: 'Kruis Court', unit: 'B1', firstName: 'Naledi', lastName: 'Phiri', email: 'naledi@example.co.za',
      phone: '0821234567', startDate: addDaysIso(today, -400), endDate: addDaysIso(today, 300), monthlyRentCents: 900000,
      currentMonthPaid: true,
    }];
    const done = await call('POST', '/leases/import', LANDLORD, { rows, dryRun: false, invite: true });
    expect(done.status).toBe(201);
    const leaseId = done.body.leaseIds[0];
    const token = await tokenFor('naledi@example.co.za');
    expect((await call('POST', '/invites/lookup', NOBODY, { token })).body.hasAccount).toBe(true);
    const wrong = await call('POST', '/invites/accept', NOBODY, { token, password: 'not-her-password', consentVersion: PRIVACY_VERSION });
    expect(wrong.status).toBe(401);
    expect((await call('GET', `/leases/${leaseId}`, { sub: 'sub-tenant', groups: 'tenant' })).status).toBe(403);

    const right = await call('POST', '/invites/accept', NOBODY, { token, password: 'dev', consentVersion: PRIVACY_VERSION });
    expect(right.status).toBe(201);
    expect(right.body.user.sub).toBe('sub-tenant');
    expect((await call('GET', `/leases/${leaseId}`, { sub: 'sub-tenant', groups: 'tenant' })).status).toBe(200);
    // Her existing tenant record took the lease; the one typed in for the import is gone.
    expect(await db.query(`select 1 from applicant where email = 'naledi@example.co.za'`)).toHaveLength(1);
    expect((await call('POST', `/leases/${leaseId}/tenant-invite`, LANDLORD)).status).toBe(409);
  });

  it('bills the month after import through the normal run', async () => {
    const next = nextMonthStart(monthStart);
    await runInvoices({ periods: [next] });
    const rows = await db.query(`select 1 from invoice i join lease l on l.id = i.lease_id where l.source = 'import' and i.period_start = $1`, [next]);
    expect(rows).toHaveLength(3);
  });
});
