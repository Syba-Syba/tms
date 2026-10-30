import { beforeAll, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRIVACY_VERSION } from '../domain/privacy';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const ONE_PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** The second audit: erasure that reached landlords nobody asked, a reset link readable from a
    stolen session, files left behind, and a lockout anyone could trigger. */
type As = { sub: string; groups: string };
const LANDLORD: As = { sub: 'sub-landlord', groups: 'landlord' };
const OTHER: As = { sub: 'sub-landlord-two', groups: 'landlord' };
const SEED_LANDLORD = '11111111-1111-1111-1111-111111111111';
const UNIT_B1 = '33333333-3333-3333-3333-333333333335';

let call: (method: string, path: string, as: As | null, body?: unknown, ip?: string) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let storage: typeof import('../lib/storage');
let otherLandlord: string;
let otherUnit: string;
let otherUnit2: string;

const register = async (name: string, email: string) => {
  const made = await call('POST', '/auth/register', null, { name, email, password: 'long-enough-1', consentVersion: PRIVACY_VERSION });
  return { sub: made.body.user.sub as string, groups: 'tenant' };
};
const apply = (as: As, body: Record<string, unknown>) =>
  call('POST', '/applications', as, {
    unitId: UNIT_B1, firstName: 'Bongi', lastName: 'Dube', idNumber: '9001015009086', phone: '0825550177',
    employmentStatus: 'employed', monthlyIncomeCents: 4500000, occupants: 1, preferredMoveIn: '2099-01-01',
    consentVersion: PRIVACY_VERSION, ...body,
  });
const put = (key: string) => storage.storage().put(key, new Uint8Array([1, 2, 3]), 'application/pdf');
const present = (key: string) => existsSync(storage.localPathFor(key));

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://privacy-audit-2-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.AUTH_DRIVER = 'local';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'tms-privacy-audit-2-'));
  process.env.KMS_DRIVER = 'local';

  db = await import('../lib/db');
  storage = await import('../lib/storage');
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  for (const file of all.filter((n) => !n.includes('seed'))) await db.execScript(read(file));
  for (const file of all.filter((n) => n.includes('seed'))) await db.execScript(read(file));

  const [other] = await db.query<{ id: string }>(
    `insert into landlord (trading_name, email, phone, cognito_sub) values ('Other Lets', 'o@example.co.za', '0820000000', $1) returning id`,
    [OTHER.sub],
  );
  otherLandlord = other!.id;
  const [property] = await db.query<{ id: string }>(
    `insert into property (landlord_id, name, address_line1, suburb, city, province, postal_code)
     values ($1, 'Other Court', '1 Other Road', 'Melville', 'Johannesburg', 'Gauteng', '2092') returning id`,
    [otherLandlord],
  );
  const [unit] = await db.query<{ id: string }>(
    `insert into unit (property_id, code, bedrooms, bathrooms, monthly_rent_cents, deposit_cents, status)
     values ($1, 'O1', 1, 1, 500000, 500000, 'vacant') returning id`,
    [property!.id],
  );
  otherUnit = unit!.id;
  const [unit2] = await db.query<{ id: string }>(
    `insert into unit (property_id, code, bedrooms, bathrooms, monthly_rent_cents, deposit_cents, status)
     values ($1, 'O2', 1, 1, 500000, 500000, 'vacant') returning id`,
    [property!.id],
  );
  otherUnit2 = unit2!.id;

  const { handler } = await import('../api');
  call = async (method, path, as, body, ip = '10.9.0.1') => {
    const event = {
      rawPath: path,
      headers: { 'content-type': 'application/json' },
      queryStringParameters: Object.fromEntries(new URLSearchParams(path.split('?')[1] ?? '')),
      pathParameters: {},
      body: body ? JSON.stringify(body) : undefined,
      requestContext: {
        http: { method, path: path.split('?')[0], sourceIp: ip, userAgent: 'privacy-audit-2' },
        authorizer: { jwt: { claims: { sub: as?.sub ?? 'anonymous', 'cognito:groups': `[${as?.groups ?? 'tenant'}]` } } },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
    const result = (await handler(event)) as { statusCode: number; body?: string };
    return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : null };
  };
}, 120_000);

describe('the data export', () => {
  it('does not hand a live password reset link to whoever holds the session', async () => {
    const as = await register('Reset Person', 'reset-export@example.co.za');
    expect((await call('POST', '/auth/reset/request', null, { email: 'reset-export@example.co.za' })).status).toBe(202);
    const [sent] = await db.query<{ body: string }>(`select body from notification where recipient_sub = $1 and kind = 'password_reset'`, [as.sub]);
    expect(sent!.body).toMatch(/token=[A-Za-z0-9_-]{20,}/);

    const exported = await call('GET', '/me/data-export', as);
    const text = JSON.stringify(exported.body.messagesSentToYou);
    expect(text).toContain('reset-password?token=[removed]');
    expect(text).not.toMatch(/token=[A-Za-z0-9_-]{20,}/);
  });
});

describe('erasure answers for one landlord at a time', () => {
  it('leaves a landlord the person never asked untouched, account included', async () => {
    const as = await register('Bongi Dube', 'bongi@example.co.za');
    const toA = await apply(as, { email: 'bongi@example.co.za' });
    expect(toA.status).toBe(201);
    await call('POST', `/applications/${toA.body.id}/decision`, LANDLORD, { outcome: 'declined', reason: 'Unit let to someone else.' });
    expect((await call('POST', '/me/erasure-request', as, {})).status).toBe(201);

    // After asking A only, they apply to B, who gives them a lease.
    const toB = await apply(as, { email: 'bongi@example.co.za', unitId: otherUnit });
    expect(toB.status).toBe(201);
    const docB = `applications/${toB.body.id}/id_copy/b.pdf`;
    await db.query(
      `insert into application_document (application_id, kind, s3_key, content_type, size_bytes) values ($1, 'id_copy', $2, 'application/pdf', 3)`,
      [toB.body.id, docB],
    );
    await put(docB);
    const [applicantB] = await db.query<{ applicant_id: string }>('select applicant_id from application where id = $1', [toB.body.id]);
    const leasePdf = 'leases/b-live/lease.pdf';
    await put(leasePdf);
    const [leaseB] = await db.query<{ id: string }>(
      `insert into lease (application_id, unit_id, applicant_id, start_date, end_date, monthly_rent_cents, deposit_cents, status, pdf_s3_key)
       values ($1, $2, $3, current_date - 10, current_date + 355, 500000, 500000, 'active', $4) returning id`,
      [toB.body.id, otherUnit, applicantB!.applicant_id, leasePdf],
    );

    const request = (await call('GET', '/privacy-requests', LANDLORD)).body.items.find((i: { email: string }) => i.email === 'bongi@example.co.za');
    expect((await call('POST', `/privacy-requests/${request.id}/decision`, LANDLORD, { decision: 'erase' })).status).toBe(200);

    // B's paperwork, B's lease document and the person's account all stand.
    expect(present(docB)).toBe(true);
    const [lease] = await db.query<{ pdf_s3_key: string; first_name: string }>(
      'select l.pdf_s3_key, a.first_name from lease l join applicant a on a.id = l.applicant_id where l.id = $1',
      [leaseB!.id],
    );
    expect(lease).toEqual({ pdf_s3_key: leasePdf, first_name: 'Bongi' });
    expect((await call('POST', '/auth/login', null, { email: 'bongi@example.co.za', password: 'long-enough-1' })).status).toBe(200);

    // A, who erased, no longer sees who it was: the application now shows an erased person.
    const list = await call('GET', '/applications?status=all', LANDLORD);
    expect(JSON.stringify(list.body)).not.toContain('Bongi');
    const [onA] = await db.query<{ first_name: string; email: string }>(
      'select a.first_name, a.email from application ap join applicant a on a.id = ap.applicant_id where ap.id = $1',
      [toA.body.id],
    );
    expect(onA!.first_name).toBe('Erased');
    expect(onA!.email).toMatch(/@invalid$/);
    // And its record of the request keeps no name or email.
    const answered = (await call('GET', '/privacy-requests', LANDLORD)).body.items.find((i: { id: string }) => i.id === request.id);
    expect(answered).toMatchObject({ status: 'completed', name: 'Erased person', email: null });
  });

  it('deletes the documents generated about the tenant, not only the uploads', async () => {
    const as = await register('Sipho Khumalo', 'sipho-k@example.co.za');
    const made = await apply(as, { email: 'sipho-k@example.co.za', firstName: 'Sipho', lastName: 'Khumalo', unitId: otherUnit2 });
    expect(made.status).toBe(201);
    const [{ applicant_id }] = (await db.query<{ applicant_id: string }>('select applicant_id from application where id = $1', [made.body.id])) as [{ applicant_id: string }];
    const [lease] = await db.query<{ id: string }>(
      `insert into lease (application_id, unit_id, applicant_id, start_date, end_date, monthly_rent_cents, deposit_cents, status)
       values ($1, $2, $3, current_date - 3000, current_date - 2600, 500000, 500000, 'terminated') returning id`,
      [made.body.id, otherUnit2, applicant_id],
    );
    const keys = { report: `inspections/${lease!.id}/sealed.pdf`, draft: `inspections/${lease!.id}/draft.pdf`, statement: `terminations/${lease!.id}/statement.pdf`, demand: `arrears/${lease!.id}/demand.pdf` };
    for (const key of Object.values(keys)) await put(key);
    await db.query(
      `insert into inspection (lease_id, kind, scheduled_for, status, pdf_s3_key, draft_s3_key)
       values ($1, 'outgoing', current_date - 2600, 'completed', $2, $3)`,
      [lease!.id, keys.report, keys.draft],
    );
    await db.query(
      `insert into termination (lease_id, initiated_by, reason, notice_given_on, effective_on, notice_days, status, statement_s3_key)
       values ($1, 'tenant', 'end_of_term', current_date - 2700, current_date - 2600, 20, 'settled', $2)`,
      [lease!.id, keys.statement],
    );
    const [arrears] = await db.query<{ id: string }>(`insert into arrears_case (lease_id, opened_on) values ($1, current_date - 2700) returning id`, [lease!.id]);
    await db.query(
      `insert into arrears_step (case_id, step, taken_on, days_late, outstanding_cents, remedy_by, document_s3_key, taken_by)
       values ($1, 'letter_of_demand', current_date - 2690, 10, 500000, current_date - 2680, $2, 'system')`,
      [arrears!.id, keys.demand],
    );

    const { erasePerson } = await import('../lib/privacy');
    await erasePerson(as.sub, { sub: OTHER.sub, role: 'landlord' }, { landlordId: otherLandlord });

    const [inspection] = await db.query<{ pdf_s3_key: string | null; draft_s3_key: string | null }>(
      'select pdf_s3_key, draft_s3_key from inspection where lease_id = $1', [lease!.id],
    );
    expect(inspection).toEqual({ pdf_s3_key: null, draft_s3_key: null });
    expect(present(keys.report)).toBe(false);
    expect(present(keys.draft)).toBe(false);
    const [termination] = await db.query<{ statement_s3_key: string | null }>('select statement_s3_key from termination where lease_id = $1', [lease!.id]);
    expect(termination!.statement_s3_key).toBeNull();
    expect(present(keys.statement)).toBe(false);
    const [letter] = await db.query<{ document_s3_key: string }>('select document_s3_key from arrears_step where case_id = $1', [arrears!.id]);
    expect(letter!.document_s3_key).toMatch(/^erased\//);
    expect(present(keys.demand)).toBe(false);
  });

  it('erases an account that never applied from the activity log too, IP addresses included', async () => {
    const as = await register('Solo Person', 'solo@example.co.za');
    await call('POST', '/auth/login', null, { email: 'solo@example.co.za', password: 'wrong-password-1' }, '10.9.9.9');
    expect((await call('POST', '/me/erasure-request', as, {})).body.status).toBe('completed');
    const left = await db.query(`select action from audit_log where detail::text like '%solo@example.co.za%' or detail::text like '%10.9.9.9%'`);
    expect(left).toHaveLength(0);
    const consent = await db.query<{ ip_address: string | null }>('select ip_address from consent where person_sub = $1', [as.sub]);
    for (const row of consent) expect(row.ip_address).toBeNull();
  });
});

describe('files nothing points at any more', () => {
  it('removes the raw upload once a photo is confirmed', async () => {
    const presigned = await call('POST', `/units/${UNIT_B1}/photos`, LANDLORD, { contentType: 'image/png', sizeBytes: 70 });
    expect(presigned.status).toBe(201);
    await storage.storage().put(presigned.body.key, Buffer.from(ONE_PX, 'base64'), 'image/png');
    const confirmed = await call('POST', '/photos/confirm', LANDLORD, { scope: 'unit', photoId: presigned.body.photoId });
    expect(confirmed.status).toBe(200);
    expect(present(confirmed.body.key)).toBe(true);
    expect(present(presigned.body.key)).toBe(false);
  });

  it('removes the slip with a deleted expense', async () => {
    const created = await call('POST', '/expenses', LANDLORD, {
      category: 'repairs', description: 'Gate motor', amountCents: 90000, incurredOn: '2026-10-01',
      slip: { contentType: 'image/png', sizeBytes: 70 },
    });
    expect(created.status).toBe(201);
    const [row] = await db.query<{ slip_s3_key: string }>('select slip_s3_key from expense where id = $1', [created.body.id]);
    await storage.storage().put(row!.slip_s3_key, Buffer.from(ONE_PX, 'base64'), 'image/png');
    const confirmed = await call('POST', `/expenses/${created.body.id}/slip/confirm`, LANDLORD);
    expect(confirmed.status).toBe(200);
    expect(present(confirmed.body.key)).toBe(true);

    expect((await call('DELETE', `/expenses/${created.body.id}`, LANDLORD)).status).toBe(200);
    expect(present(confirmed.body.key)).toBe(false);
    expect(present(row!.slip_s3_key)).toBe(false);
  });

  it('removes the lease PDF a new render replaces', async () => {
    const [lease] = await db.query<{ id: string }>(
      `select l.id from lease l where not exists (select 1 from lease_signature s where s.lease_id = l.id)
         and l.unit_id in (select u.id from unit u join property p on p.id = u.property_id where p.landlord_id = $1) limit 1`,
      [SEED_LANDLORD],
    );
    expect(lease).toBeDefined();
    const old = `leases/${lease!.id}/lease-old-render.pdf`;
    await put(old);
    await db.query('update lease set pdf_s3_key = $2 where id = $1', [lease!.id, old]);
    const rendered = await call('POST', `/leases/${lease!.id}/render`, LANDLORD, {});
    expect(rendered.status).toBe(200);
    expect(present(old)).toBe(false);
  });
});

describe('input and sign-in', () => {
  it('refuses a name a spreadsheet would run as a formula', async () => {
    const as = await register('Formula Person', 'formula@example.co.za');
    const made = await apply(as, { email: 'formula@example.co.za', firstName: '=HYPERLINK("https://x","Pay")' });
    expect(made.status).toBe(400);
    expect((await apply(as, { email: 'formula@example.co.za', firstName: "Thandi-Mae O'Neil" })).status).toBe(201);
  });

  it('lets the owner back in through a password reset while someone else is guessing', async () => {
    await register('Locked Owner', 'locked@example.co.za');
    for (let i = 0; i < 10; i += 1) {
      await call('POST', '/auth/login', null, { email: 'locked@example.co.za', password: 'guess-guess-' + i }, `10.66.0.${i}`);
    }
    // Locked for everyone, the right password included: guesses can come from many addresses.
    const locked = await call('POST', '/auth/login', null, { email: 'locked@example.co.za', password: 'long-enough-1' }, '10.77.0.1');
    expect(locked.status).toBe(429);
    expect(locked.body.error.message).toMatch(/reset your password/);

    // The owner resets through their inbox, and can sign in at once.
    await call('POST', '/auth/reset/request', null, { email: 'locked@example.co.za' }, '10.77.0.1');
    const [sent] = await db.query<{ body: string }>(
      `select n.body from notification n join local_credential c on c.sub = n.recipient_sub
        where c.email = 'locked@example.co.za' and n.kind = 'password_reset'`,
    );
    const token = /token=([A-Za-z0-9_-]+)/.exec(sent!.body)![1];
    expect((await call('POST', '/auth/reset/confirm', null, { token, newPassword: 'a-new-long-password' }, '10.77.0.1')).status).toBe(200);
    expect((await call('POST', '/auth/login', null, { email: 'locked@example.co.za', password: 'a-new-long-password' }, '10.77.0.1')).status).toBe(200);
  });

  it('forgets failed sign-ins after 90 days', async () => {
    await db.query(
      `insert into audit_log (actor_sub, actor_role, action, entity, detail, at)
       values ('', 'unknown', 'auth.login_failed', 'credential', '{"email":"old@example.co.za","address":"10.1.1.1"}', now() - interval '91 days')`,
    );
    const { handler } = await import('../handlers/privacy-sweep');
    await handler();
    expect(await db.query(`select 1 from audit_log where detail::text like '%old@example.co.za%'`)).toHaveLength(0);
  });
});
