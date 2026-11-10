import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { PRIVACY_VERSION } from '../domain/privacy';

/** The fifth audit, privacy and operations: what an erasure left behind or over-reached into,
    skip-mode logs, the data export, restores that bring erased people back, the AWS public
    routes, and the health check's scan of the activity log. */

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '../../../db/migrations');
const DEPLOY = join(HERE, '../../../../deploy');
const API_ROOT = join(HERE, '../..');
type As = { sub: string; groups: string };
const LANDLORD: As = { sub: 'sub-landlord', groups: 'landlord' };
const SEED_LANDLORD = '11111111-1111-1111-1111-111111111111';
const ACTOR = { sub: LANDLORD.sub, role: 'landlord' };

let call: (method: string, path: string, as: As | null, body?: unknown) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let privacy: typeof import('../lib/privacy');
let otherLandlord: string;
let otherProperty: string;
let seedProperty: string;
let unitNo = 0;
let emailNo = 0;

const register = async (name: string, email: string) => {
  const made = await call('POST', '/auth/register', null, { name, email, password: 'long-enough-1', consentVersion: PRIVACY_VERSION });
  expect(made.status).toBe(201);
  return { sub: made.body.user.sub as string, groups: 'tenant' };
};
const newUnit = async (propertyId: string) => {
  unitNo += 1;
  const [unit] = await db.query<{ id: string }>(
    `insert into unit (property_id, code, bedrooms, bathrooms, monthly_rent_cents, deposit_cents, status)
     values ($1, $2, 1, 1, 500000, 500000, 'vacant') returning id`,
    [propertyId, `P5-${unitNo}`],
  );
  return unit!.id;
};
const apply = async (as: As, unitId: string, body: Record<string, unknown> = {}) => {
  const made = await call('POST', '/applications', as, {
    unitId, firstName: 'Naledi', lastName: 'Phiri', idNumber: '9001015009086', phone: '0825551234',
    employmentStatus: 'employed', monthlyIncomeCents: 2000000, occupants: 1, preferredMoveIn: '2099-01-01',
    consentVersion: PRIVACY_VERSION, ...body,
  });
  expect(made.status).toBe(201);
  return made.body.id as string;
};
const leaseOn = async (applicationId: string) => {
  const [row] = await db.query<{ id: string; ref_no: string }>(
    `insert into lease (application_id, unit_id, applicant_id, start_date, end_date, monthly_rent_cents, deposit_cents, status)
     select id, unit_id, applicant_id, '2015-01-01', '2016-01-01', 500000, 500000, 'terminated' from application where id = $1
     returning id, ref_no::text`,
    [applicationId],
  );
  return { id: row!.id, ref: `LSE-${row!.ref_no.padStart(5, '0')}` };
};
/** A tenant of the seed landlord with an ended lease, ready to be erased. */
const tenancy = async (name = 'Naledi Phiri') => {
  emailNo += 1;
  const email = `p5-${emailNo}@example.co.za`;
  const as = await register(name, email);
  const [firstName, lastName] = name.split(' ');
  const app = await apply(as, await newUnit(seedProperty), { email, firstName, lastName });
  const lease = await leaseOn(app);
  return { as, email, app, lease };
};
const bankLine = async (description: string, status: 'unmatched' | 'ignored' | 'matched', leaseId: string | null = null) => {
  const [imp] = await db.query<{ id: string }>(
    `insert into bank_import (landlord_id, file_name, format, imported_by) values ($1, 's.csv', 'csv', 'sub-landlord') returning id`,
    [SEED_LANDLORD],
  );
  const [line] = await db.query<{ id: string }>(
    `insert into bank_line (import_id, landlord_id, posted_on, amount_cents, description, fingerprint, status, lease_id)
     values ($1, $2, '2015-06-01', 500000, $3, gen_random_uuid()::text, $4, $5) returning id`,
    [imp!.id, SEED_LANDLORD, description, status, leaseId],
  );
  return line!.id;
};

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://privacy-audit-5-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.AUTH_DRIVER = 'local';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'tms-privacy-audit-5-'));
  process.env.KMS_DRIVER = 'local';

  db = await import('../lib/db');
  privacy = await import('../lib/privacy');
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  for (const file of all.filter((n) => !n.includes('seed'))) await db.execScript(read(file));
  for (const file of all.filter((n) => n.includes('seed'))) await db.execScript(read(file));

  const [other] = await db.query<{ id: string }>(
    `insert into landlord (trading_name, email, phone, cognito_sub) values ('Other Lets', 'o5@example.co.za', '0820000000', 'sub-landlord-five') returning id`,
  );
  otherLandlord = other!.id;
  const [property] = await db.query<{ id: string }>(
    `insert into property (landlord_id, name, address_line1, suburb, city, province, postal_code)
     values ($1, 'Other Court', '1 Other Road', 'Melville', 'Johannesburg', 'Gauteng', '2092') returning id`,
    [otherLandlord],
  );
  otherProperty = property!.id;
  seedProperty = (await db.query<{ property_id: string }>(
    `select u.property_id from unit u join property p on p.id = u.property_id where p.landlord_id = $1 limit 1`,
    [SEED_LANDLORD],
  ))[0]!.property_id;

  const { handler } = await import('../api');
  call = async (method, path, as, body) => {
    const event = {
      rawPath: path,
      headers: { 'content-type': 'application/json' },
      queryStringParameters: Object.fromEntries(new URLSearchParams(path.split('?')[1] ?? '')),
      pathParameters: {},
      body: body ? JSON.stringify(body) : undefined,
      requestContext: {
        http: { method, path: path.split('?')[0], sourceIp: `10.5.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, userAgent: 'privacy-audit-5' },
        authorizer: { jwt: { claims: { sub: as?.sub ?? 'anonymous', 'cognito:groups': `[${as?.groups ?? 'tenant'}]` } } },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
    const result = (await handler(event)) as { statusCode: number; body?: string };
    return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : null };
  };
}, 120_000);

afterEach(() => vi.restoreAllMocks());

describe('18: erasure clears what the deposit ledger quotes', () => {
  it('clears the bank or slip text on deposits received, and keeps the import note', async () => {
    const t = await tenancy();
    await db.query(
      `insert into deposit_ledger (lease_id, entry_type, amount_cents, occurred_on, note) values
         ($1, 'received', 250000, '2015-01-01', $2),
         ($1, 'received', 250000, '2015-02-01', 'Held before the lease was brought into Threshold')`,
      [t.lease.id, `N PHIRI DEPOSIT ${t.lease.ref}`],
    );
    await privacy.erasePerson(t.as.sub, ACTOR, { landlordId: SEED_LANDLORD });
    const notes = (await db.query<{ note: string | null }>('select note from deposit_ledger where lease_id = $1 order by occurred_on', [t.lease.id]))
      .map((row) => row.note);
    expect(notes).toEqual([null, 'Held before the lease was brought into Threshold']);
  });
});

describe('19 and 56: identity erasure rewrites only rows about the person', () => {
  it("leaves other landlords' rows that merely contain the name or a look-alike email", async () => {
    const as = await register('Ann', 'ann_b@example.co.za');
    const app = await apply(as, await newUnit(seedProperty), { email: 'ann_b@example.co.za' });
    await call('POST', `/applications/${app}/decision`, LANDLORD, { outcome: 'declined', reason: 'Unit let to someone else.' });

    const [unrelated] = await db.query<{ id: string }>(
      `insert into audit_log (actor_sub, actor_role, action, entity, detail) values
         ('sub-landlord-five', 'landlord', 'property.created', 'property', '{"name": "Annandale Court"}'),
         ('sub-landlord-five', 'landlord', 'charge.added', 'lease', '{"description": "Naledi Phiri paid the plumber"}'),
         (null, null, 'auth.login_failed', 'credential', '{"email": "annxb@example.co.za", "address": "10.9.9.9"}')
       returning id`,
    );
    await db.query(
      `insert into audit_log (actor_sub, actor_role, action, entity, detail) values
         ($1, 'tenant', 'profile.note', 'person', '{"note": "I am Ann, call me"}'),
         (null, null, 'auth.login_failed', 'credential', '{"email": "Ann_B@example.co.za", "address": "10.8.8.8"}')`,
      [as.sub],
    );

    const erased = await privacy.erasePerson(as.sub, ACTOR, { landlordId: SEED_LANDLORD });
    expect(erased.identityErased).toBe(true);

    const others = await db.query<{ detail: Record<string, unknown> }>(
      `select detail from audit_log where id between $1 and $1 + 2 order by id`,
      [unrelated!.id],
    );
    expect(others.map((row) => row.detail)).toEqual([
      { name: 'Annandale Court' },
      { description: 'Naledi Phiri paid the plumber' },
      { email: 'annxb@example.co.za', address: '10.9.9.9' },
    ]);
    const own = await db.query<{ detail: Record<string, unknown> }>(
      `select detail from audit_log where actor_sub = $1 and action = 'profile.note'`,
      [as.sub],
    );
    expect(own[0]!.detail).toEqual({ note: 'I am the tenant, call me' });
    const failed = await db.query<{ detail: Record<string, unknown> }>(
      `select detail from audit_log where action = 'auth.login_failed' and id > $1 and detail->>'email' not like 'annxb%'`,
      [unrelated!.id],
    );
    expect(failed.map((row) => row.detail)).toEqual([{ email: '[email removed]' }]);
  });
});

describe("19 review: rows the landlord wrote about the person's records are scrubbed too", () => {
  it('takes the name and email out of a decline reason on the erased application, and keeps the landlord\'s IP', async () => {
    const t = await tenancy();
    await db.query(
      `insert into audit_log (actor_sub, actor_role, action, entity, entity_id, detail) values
         ('sub-landlord', 'landlord', 'application.decided', 'application', $1, $2::jsonb)`,
      [t.app, JSON.stringify({ reason: `Naledi Phiri's payslips looked forged, wrote from ${t.email.toUpperCase()}`, address: '10.1.1.1' })],
    );
    const erased = await privacy.erasePerson(t.as.sub, ACTOR, { landlordId: SEED_LANDLORD });
    expect(erased.identityErased).toBe(true);
    const [row] = await db.query<{ detail: Record<string, unknown> }>(
      `select detail from audit_log where action = 'application.decided' and actor_sub = 'sub-landlord' and detail->>'address' = '10.1.1.1'`,
    );
    expect(row!.detail).toEqual({ reason: "the tenant's payslips looked forged, wrote from [email removed]", address: '10.1.1.1' });
  });

  it('keeps the JSON whole when a name is also a JSON word, and scrubs a name stored with a quote', async () => {
    emailNo += 1;
    const email = `p5-${emailNo}@example.co.za`;
    const as = await register('true', email);
    const app = await apply(as, await newUnit(seedProperty), { email, firstName: 'Thandi', lastName: 'Okafor' });
    await db.query(`update applicant set last_name = 'O"Kafor' where id = (select applicant_id from application where id = $1)`, [app]);
    await db.query(
      `insert into audit_log (actor_sub, actor_role, action, entity, entity_id, detail) values
         ($1, 'tenant', 'profile.note', 'person', null, '{"flag": true, "note": "a true story"}'::jsonb),
         ('sub-landlord', 'landlord', 'charge.added', 'application', $2, $3::jsonb)`,
      [as.sub, app, JSON.stringify({ description: 'Paid by Thandi O"Kafor' })],
    );
    const erased = await privacy.erasePerson(as.sub, ACTOR, { landlordId: SEED_LANDLORD });
    expect(erased.identityErased).toBe(true);
    const [own] = await db.query<{ detail: Record<string, unknown> }>(
      `select detail from audit_log where action = 'profile.note' and detail->>'note' like 'a % story'`,
    );
    expect(own!.detail).toEqual({ flag: true, note: 'a the tenant story' });
    const [theirs] = await db.query<{ detail: Record<string, unknown> }>(
      `select detail from audit_log where action = 'charge.added' and entity_id = $1`,
      [app],
    );
    expect(theirs!.detail).toEqual({ description: 'Paid by the tenant' });
  });
});

describe("20: bank lines never matched to the lease lose the tenant's details", () => {
  it('blanks unmatched and ignored lines that name them or quote their lease, and no others', async () => {
    const t = await tenancy('Naledi Ramaphosa');
    const named = await bankLine('N RAMAPHOSA RENT', 'unmatched');
    const quoted = await bankLine(`DUPLICATE ${t.lease.ref}`, 'ignored');
    const someoneElse = await bankLine('T MOKOENA RENT', 'unmatched');
    await privacy.erasePerson(t.as.sub, ACTOR, { landlordId: SEED_LANDLORD });
    const read = async (id: string) => (await db.query<{ description: string }>('select description from bank_line where id = $1', [id]))[0]!.description;
    expect(await read(named)).toBe('[erased]');
    expect(await read(quoted)).toBe('[erased]');
    expect(await read(someoneElse)).toBe('T MOKOENA RENT');
  });

  it('leaves a line by surname alone when another of the landlord\'s tenants shares it', async () => {
    const t = await tenancy('Naledi Dlamini');
    const otherAs = await register('Sipho Dlamini', `p5-sipho@example.co.za`);
    await apply(otherAs, await newUnit(seedProperty), { email: 'p5-sipho@example.co.za', firstName: 'Sipho', lastName: 'Dlamini' });
    const ambiguous = await bankLine('DLAMINI RENT', 'unmatched');
    await privacy.erasePerson(t.as.sub, ACTOR, { landlordId: SEED_LANDLORD });
    expect((await db.query<{ description: string }>('select description from bank_line where id = $1', [ambiguous]))[0]!.description).toBe('DLAMINI RENT');
  });
});

describe('21: messages to an imported record merged on claiming go with the erasure', () => {
  it("deletes WhatsApp messages on the erased leases addressed to the old record", async () => {
    const t = await tenancy();
    await db.query(
      `insert into notification (lease_id, recipient_sub, recipient_to, channel, category, kind, subject, body)
       values ($1, 'applicant:' || gen_random_uuid(), '+27825550000', 'whatsapp', 'lease', 'notice_served', 'Notice', 'A notice')`,
      [t.lease.id],
    );
    await privacy.erasePerson(t.as.sub, ACTOR, { landlordId: SEED_LANDLORD });
    expect(await db.query(`select 1 from notification where recipient_to = '+27825550000'`)).toHaveLength(0);
  });
});

describe('22: erasure scrubs every name the record carried', () => {
  it('removes the name a message was sent under after the record was renamed', async () => {
    const t = await tenancy();
    await db.query(
      `insert into notification (lease_id, recipient_sub, recipient_to, channel, category, kind, subject, body)
       values ($1, 'sub-landlord', 'landlord@example.co.za', 'email', 'money', 'proof_submitted', 'Proof of payment from Naledi Phiri', 'Naledi Phiri sent a slip')`,
      [t.lease.id],
    );
    // Applying to another landlord under a new surname rewrites the shared record.
    await apply(t.as, await newUnit(otherProperty), { email: t.email, lastName: 'Mokoena' });
    expect((await db.query<{ last_name: string }>('select last_name from applicant where cognito_sub = $1', [t.as.sub]))[0]!.last_name).toBe('Mokoena');

    await privacy.erasePerson(t.as.sub, ACTOR, { landlordId: SEED_LANDLORD });
    const [message] = await db.query<{ subject: string; body: string }>(
      `select subject, body from notification where lease_id = $1 and kind = 'proof_submitted'`,
      [t.lease.id],
    );
    expect(message).toEqual({ subject: 'Proof of payment from the tenant', body: 'the tenant sent a slip' });
  });

  it('keeps the name the landlord typed when an imported tenancy is claimed by an existing record', async () => {
    const t = await tenancy();
    const [typed] = await db.query<{ id: string }>(
      `insert into applicant (first_name, last_name, id_number_enc, id_number_last4, email, phone, monthly_income_cents)
       values ('Nal', 'Phiri-Typed', '\\x01', '9086', $1, '', 0) returning id`,
      [t.email],
    );
    const unit = await newUnit(seedProperty);
    const [app] = await db.query<{ id: string }>(
      `insert into application (unit_id, applicant_id, status, preferred_move_in, source) values ($1, $2, 'approved', '2015-01-01', 'import') returning id`,
      [unit, typed!.id],
    );
    const imported = await leaseOn(app!.id);
    await db.query(
      `insert into notification (lease_id, recipient_sub, recipient_to, channel, category, kind, subject, body)
       values ($1, 'sub-landlord', 'landlord@example.co.za', 'email', 'lease', 'note', 'About Nal Phiri-Typed', 'x')`,
      [imported.id],
    );
    // What invites-accept.ts does for an account that already has a record.
    const own = (await db.query<{ id: string }>('select id from applicant where cognito_sub = $1', [t.as.sub]))[0]!.id;
    await db.query('update lease set applicant_id = $1 where applicant_id = $2', [own, typed!.id]);
    await db.query('update application set applicant_id = $1 where applicant_id = $2', [own, typed!.id]);
    await db.query('delete from applicant where id = $1', [typed!.id]);

    await privacy.erasePerson(t.as.sub, ACTOR, { landlordId: SEED_LANDLORD });
    const [message] = await db.query<{ subject: string }>(`select subject from notification where lease_id = $1 and kind = 'note'`, [imported.id]);
    expect(message!.subject).toBe('About the tenant');
    // The identity went too, and the names with it.
    expect(await db.query('select 1 from applicant_name where applicant_id = $1', [own])).toHaveLength(0);
  });
});

describe('23: skip-mode dispatch keeps names out of the logs', () => {
  it('logs the kind of message, not its subject', async () => {
    await db.query(`update notification set status = 'skipped' where status = 'pending'`);
    await db.query(
      `insert into notification (recipient_sub, recipient_to, channel, category, kind, subject, body)
       values ('sub-landlord', 'landlord@example.co.za', 'email', 'money', 'arrears_letter_ready', 'Naledi Phiri owes R12 000,00: letter of demand ready', 'x')`,
    );
    const lines: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' ')));
    }
    const writes = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => (lines.push(String(chunk)), true));
    const { handler } = await import('../handlers/notifications-dispatch');
    await handler();
    writes.mockRestore();
    const all = lines.join('\n');
    expect(all).toContain('arrears_letter_ready');
    expect(all).not.toContain('Naledi');
    expect(all).not.toContain('R12');
  });
});

describe('24: the data export lists every file and line held about the person', () => {
  it('lists lease, invoice and other documents, invoice lines, charges and bank lines, and says when lists are cut', async () => {
    const t = await tenancy();
    await db.query(`update lease set pdf_s3_key = 'leases/x.pdf' where id = $1`, [t.lease.id]);
    const [invoice] = await db.query<{ id: string }>(
      `insert into invoice (lease_id, period_start, due_on, total_cents, status, pdf_s3_key)
       values ($1, '2015-02-01', '2015-02-01', 500000, 'paid', 'invoices/x.pdf') returning id`,
      [t.lease.id],
    );
    await db.query(`insert into invoice_line (invoice_id, kind, description, amount_cents) values ($1, 'rent', 'Rent · February', 500000)`, [invoice!.id]);
    await db.query(
      `insert into pending_charge (lease_id, period_start, kind, description, amount_cents, added_by) values ($1, '2015-03-01', 'utility', 'Water', 12000, 'sub-landlord')`,
      [t.lease.id],
    );
    await bankLine('N PHIRI RENT FEB', 'matched', t.lease.id);
    const exported = await call('GET', '/me/data-export', t.as);
    expect(exported.status).toBe(200);
    const body = exported.body;
    const kinds = body.documents.map((d: { document: string }) => d.document);
    expect(kinds).toEqual(expect.arrayContaining(['lease', 'invoice']));
    expect(body.documents.every((d: Record<string, unknown>) => !('s3_key' in d) && !('key' in d))).toBe(true);
    expect(body.invoiceLines).toEqual([expect.objectContaining({ description: 'Rent · February', amount_cents: 500000 })]);
    expect(body.pendingCharges).toEqual([expect.objectContaining({ description: 'Water' })]);
    expect(body.bankLines).toEqual([expect.objectContaining({ description: 'N PHIRI RENT FEB' })]);
    expect(body.truncated).toEqual({ messagesSentToYou: false, activity: false });
    expect(body.note).not.toMatch(/^Everything/);
  });
});

describe('25 and 53: erasures are replayed after a restore', () => {
  it('re-erases a person a restored backup brought back, once', async () => {
    const t = await tenancy();
    // The key restore.sh reads from the database that was live before the restore.
    const recorded = [{ key: '999999@1762400000.5', personSub: t.as.sub, landlordId: SEED_LANDLORD }];
    expect(await privacy.replayErasures(recorded)).toBe(1);
    expect(await db.query('select 1 from applicant where cognito_sub = $1', [t.as.sub])).toHaveLength(0);
    const [row] = await db.query<{ detail: Record<string, unknown> }>(
      `select detail from audit_log where action = 'privacy.erased' and detail->>'personSub' = $1`,
      [t.as.sub],
    );
    expect(row!.detail.replayOf).toBe('999999@1762400000.5');
    // A second restore lists it again: it is not done twice.
    expect(await privacy.replayErasures(recorded)).toBe(0);
  });

  it('skips an erasure the restored database already holds', async () => {
    const t = await tenancy();
    await privacy.erasePerson(t.as.sub, ACTOR, { landlordId: SEED_LANDLORD });
    const [row] = await db.query<{ key: string }>(
      `select id::text || '@' || to_char(at at time zone 'UTC', 'YYYYMMDDHH24MISSUS') as key from audit_log
        where action = 'privacy.erased' and detail->>'personSub' = $1`,
      [t.as.sub],
    );
    expect(await privacy.replayErasures([{ key: row!.key, personSub: t.as.sub, landlordId: SEED_LANDLORD }])).toBe(0);
  });

  it('reads the list restore.sh and backup.sh write', () => {
    expect(privacy.parseErasureList('1762400000|12@1762400000.5|local-abc|11111111-1111-1111-1111-111111111111\n1762400001|13@1762400001|local-def|\n\n')).toEqual([
      { key: '12@1762400000.5', personSub: 'local-abc', landlordId: '11111111-1111-1111-1111-111111111111' },
      { key: '13@1762400001', personSub: 'local-def', landlordId: null },
    ]);
  });

  it('has restore.sh replay them from the old database and the list kept with the backups', () => {
    const restore = readFileSync(join(DEPLOY, 'restore.sh'), 'utf8');
    const backup = readFileSync(join(DEPLOY, 'backup.sh'), 'utf8');
    expect(restore).toContain('psql -d tms_previous');
    expect(restore).toContain('backups/erasures.txt');
    expect(restore).toContain('src/handlers/privacy-replay.ts');
    expect(backup).toContain('erasures.txt');
    // Replayed before the app starts on the restored data.
    expect(restore.indexOf('privacy-replay.ts')).toBeLessThan(restore.lastIndexOf('up -d --no-deps app'));
  });
});

describe('52: a restore starts with the jobs and the outbox held', () => {
  it('starts the app with RUN_JOBS=false until the operator resumes', () => {
    const restore = readFileSync(join(DEPLOY, 'restore.sh'), 'utf8');
    expect(restore).toMatch(/RUN_JOBS: "false"/);
    expect(restore).not.toMatch(/^compose start app backup$/m);
    expect(restore).toContain('./restore.sh resume');
    const readme = readFileSync(join(DEPLOY, 'README.md'), 'utf8');
    expect(readme).toContain('./restore.sh resume');
  });
});

describe('54: public routes skip the Cognito authorizer on AWS', () => {
  it('declares GET /listings and GET /company without an authorizer', () => {
    const config = parse(readFileSync(join(API_ROOT, 'serverless.yml'), 'utf8'));
    const events = config.functions.api.events.map((e: { httpApi: { method: string; path: string; authorizer?: unknown } }) => e.httpApi);
    for (const [method, path] of [['GET', '/listings'], ['GET', '/company'], ['GET', '/health'], ['POST', '/billing/notify']]) {
      const event = events.find((e: { method: string; path: string }) => e.method === method && e.path === path);
      expect(event, `${method} ${path}`).toBeDefined();
      expect(event.authorizer).toBeUndefined();
    }
  });
});

describe('57: /health reads the job runs through an index', () => {
  it('uses audit_log_entity_idx rather than scanning the table', async () => {
    const { JOB_RUNS_SQL } = await import('../handlers/health');
    await db.withTransaction(async (run) => {
      await run('set local enable_seqscan = off');
      const plan = (await run<Record<string, string>>(`explain ${JOB_RUNS_SQL}`)).map((row) => Object.values(row)[0]).join('\n');
      // Found through the index, not a full walk of it with a filter.
      expect(plan).toMatch(/audit_log_entity_idx/);
      expect(plan).toMatch(/Index Cond:.*entity = 'job'/);
    });
  });
});

describe('58: the restore messages say where the old documents really are', () => {
  it('no longer claims nightly backups include .restore-prev', () => {
    for (const file of ['restore.sh', 'README.md']) {
      const text = readFileSync(join(DEPLOY, file), 'utf8');
      expect(text, file).not.toMatch(/nightly backups include it/i);
      expect(text, file).toMatch(/not in the nightly backups/i);
    }
  });
});
