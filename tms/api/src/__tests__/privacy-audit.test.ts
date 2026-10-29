import { beforeAll, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRIVACY_VERSION } from '../domain/privacy';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

/** Audit findings on POPIA: erasure that leaves details behind, one landlord answering for
    another's records, replaced files left in storage, and an export that missed whole tables. */
type As = { sub: string; groups: string };
const LANDLORD: As = { sub: 'sub-landlord', groups: 'landlord' };
const OTHER: As = { sub: 'sub-landlord-two', groups: 'landlord' };
const UNIT_B1 = '33333333-3333-3333-3333-333333333335';

let call: (method: string, path: string, as: As | null, body?: unknown) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let storage: typeof import('../lib/storage');
let otherUnit: string;

const register = async (name: string, email: string) => {
  const made = await call('POST', '/auth/register', null, { name, email, password: 'long-enough-1', consentVersion: PRIVACY_VERSION });
  return { sub: made.body.user.sub as string, groups: 'tenant' };
};

const apply = (as: As, body: Record<string, unknown>) =>
  call('POST', '/applications', as, {
    unitId: UNIT_B1, firstName: 'Thabo', lastName: 'Molefe', idNumber: '9001015009086',
    phone: '0825550199', employmentStatus: 'employed',
    monthlyIncomeCents: 4500000, occupants: 1, preferredMoveIn: '2099-01-01', consentVersion: PRIVACY_VERSION,
    ...body,
  });

/** A lease that ended long enough ago for its records to be erasable. */
const oldLease = async (applicationId: string, unitId: string, applicantId: string) => {
  const [lease] = await db.query<{ id: string }>(
    `insert into lease (application_id, unit_id, applicant_id, start_date, end_date, monthly_rent_cents, deposit_cents, status)
     values ($1, $2, $3, current_date - 3000, current_date - 2600, 500000, 500000, 'terminated') returning id`,
    [applicationId, unitId, applicantId],
  );
  return lease!.id;
};

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://privacy-audit-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.AUTH_DRIVER = 'local';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'tms-privacy-audit-'));
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
  const [property] = await db.query<{ id: string }>(
    `insert into property (landlord_id, name, address_line1, suburb, city, province, postal_code)
     values ($1, 'Other Court', '1 Other Road', 'Melville', 'Johannesburg', 'Gauteng', '2092') returning id`,
    [other!.id],
  );
  const [unit] = await db.query<{ id: string }>(
    `insert into unit (property_id, code, bedrooms, bathrooms, monthly_rent_cents, deposit_cents, status)
     values ($1, 'O1', 1, 1, 500000, 500000, 'vacant') returning id`,
    [property!.id],
  );
  otherUnit = unit!.id;

  const { handler } = await import('../api');
  call = async (method, path, as, body) => {
    const event = {
      rawPath: path,
      headers: { 'content-type': 'application/json' },
      queryStringParameters: {},
      pathParameters: {},
      body: body ? JSON.stringify(body) : undefined,
      requestContext: {
        http: { method, path, sourceIp: '10.7.0.2', userAgent: 'privacy-audit-test' },
        authorizer: { jwt: { claims: { sub: as?.sub ?? 'anonymous', 'cognito:groups': `[${as?.groups ?? 'tenant'}]` } } },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
    const result = (await handler(event)) as { statusCode: number; body?: string };
    return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : null };
  };
}, 120_000);

describe('erasure leaves nothing that names the person', () => {
  it('blanks repair notes, payment references, the landlord\'s messages and the activity log', async () => {
    const as = await register('Thabo Molefe', 'thabo@example.co.za');
    const application = await apply(as, { email: 'thabo@example.co.za' });
    expect(application.status).toBe(201);
    const [{ applicant_id }] = (await db.query<{ applicant_id: string }>(
      'select applicant_id from application where id = $1', [application.body.id],
    )) as [{ applicant_id: string }];
    const leaseId = await oldLease(application.body.id, UNIT_B1, applicant_id);

    const [ticket] = await db.query<{ id: string }>(
      `insert into ticket (lease_id, category, severity, title, description, target_by, created_by, rating_note)
       values ($1, 'plumbing', 'routine', 'Leak', 'Call me on 0825550199, Thabo', now(), $2, 'Thabo was happy') returning id`,
      [leaseId, as.sub],
    );
    const photo = `tickets/${ticket!.id}/leak.jpg`;
    await storage.storage().put(photo, new Uint8Array([1]), 'image/jpeg');
    await db.query(
      `insert into ticket_photo (ticket_id, phase, s3_key, content_type, size_bytes) values ($1, 'report', $2, 'image/jpeg', 1)`,
      [ticket!.id, photo],
    );
    await db.query(
      `insert into payment (lease_id, amount_cents, method, reference, received_on, recorded_by)
       values ($1, 500000, 'eft', 'T MOLEFE LSE-00999', current_date - 2900, 'sub-landlord')`,
      [leaseId],
    );
    await db.query(
      `insert into notification (lease_id, recipient_sub, recipient_to, channel, category, kind, subject, body)
       values ($1, 'sub-landlord', 'landlord@example.co.za', 'email', 'money', 'proof',
               'Proof of payment from Thabo Molefe', 'Thabo Molefe (thabo@example.co.za, 0825550199) sent a slip.')`,
      [leaseId],
    );

    const { erasePerson } = await import('../lib/privacy');
    await erasePerson(as.sub, { sub: 'sub-landlord', role: 'landlord' });

    const [after] = await db.query<{ description: string; rating_note: string | null }>(
      'select description, rating_note from ticket where id = $1', [ticket!.id],
    );
    expect(after!.description).not.toContain('0825550199');
    expect(after!.rating_note).toBeNull();
    expect(existsSync(storage.localPathFor(photo))).toBe(false);
    expect(await db.query('select 1 from ticket_photo where ticket_id = $1', [ticket!.id])).toHaveLength(0);

    const [payment] = await db.query<{ reference: string | null }>('select reference from payment where lease_id = $1', [leaseId]);
    expect(payment!.reference).toBeNull();

    const [message] = await db.query<{ subject: string; body: string }>(
      `select subject, body from notification where lease_id = $1 and recipient_sub = 'sub-landlord'`, [leaseId],
    );
    const text = message!.subject + message!.body;
    expect(text).not.toMatch(/Thabo|thabo@example|0825550199/);

    const logged = await db.query<{ detail: string }>(`select detail::text as detail from audit_log where detail::text like '%thabo@example.co.za%'`);
    expect(logged).toHaveLength(0);
  });
});

describe('each landlord answers for its own records', () => {
  it('splits a request across landlords, and keeps the account until the last one erases', async () => {
    const as = await register('Ayanda Zulu', 'ayanda@example.co.za');
    const toA = await apply(as, { email: 'ayanda@example.co.za', firstName: 'Ayanda', lastName: 'Zulu' });
    const toB = await apply(as, { email: 'ayanda@example.co.za', firstName: 'Ayanda', lastName: 'Zulu', unitId: otherUnit });
    expect(toA.status).toBe(201);
    expect(toB.status).toBe(201);
    const keyA = `applications/${toA.body.id}/id_copy/a.pdf`;
    const keyB = `applications/${toB.body.id}/id_copy/b.pdf`;
    for (const [id, key] of [[toA.body.id, keyA], [toB.body.id, keyB]] as const) {
      await db.query(
        `insert into application_document (application_id, kind, s3_key, content_type, size_bytes) values ($1, 'id_copy', $2, 'application/pdf', 10)`,
        [id, key],
      );
      await storage.storage().put(key, new Uint8Array([1]), 'application/pdf');
    }
    await call('POST', `/applications/${toA.body.id}/decision`, LANDLORD, { outcome: 'declined', reason: 'Unit let to someone else.' });
    await call('POST', `/applications/${toB.body.id}/decision`, OTHER, { outcome: 'declined', reason: 'Unit let to someone else.' });

    expect((await call('POST', '/me/erasure-request', as, {})).status).toBe(201);
    const mine = (who: As) =>
      call('GET', '/privacy-requests', who).then((r) => r.body.items.filter((i: { email: string }) => i.email === 'ayanda@example.co.za'));
    const [forB] = await mine(OTHER);
    const [forA] = await mine(LANDLORD);
    expect(forA).toBeDefined();
    expect(forB).toBeDefined();
    expect(forA.id).not.toBe(forB.id);

    // B erases: B's paperwork goes, A's stays, and the person can still sign in.
    expect((await call('POST', `/privacy-requests/${forB.id}/decision`, OTHER, { decision: 'erase' })).status).toBe(200);
    expect(existsSync(storage.localPathFor(keyB))).toBe(false);
    expect(existsSync(storage.localPathFor(keyA))).toBe(true);
    const [still] = await db.query<{ first_name: string }>('select first_name from applicant where cognito_sub = $1', [as.sub]);
    expect(still!.first_name).toBe('Ayanda');
    expect((await call('POST', '/auth/login', null, { email: 'ayanda@example.co.za', password: 'long-enough-1' })).status).toBe(200);
    // B cannot answer A's request.
    expect((await call('POST', `/privacy-requests/${forA.id}/decision`, OTHER, { decision: 'erase' })).status).toBe(404);

    // A erases last: now the identity and the sign-in go too.
    expect((await call('POST', `/privacy-requests/${forA.id}/decision`, LANDLORD, { decision: 'erase' })).status).toBe(200);
    expect(existsSync(storage.localPathFor(keyA))).toBe(false);
    expect(await db.query('select 1 from applicant where cognito_sub = $1', [as.sub])).toHaveLength(0);
    expect((await call('POST', '/auth/login', null, { email: 'ayanda@example.co.za', password: 'long-enough-1' })).status).toBe(401);
  });
});

describe('export', () => {
  it('includes repairs, inspections and signatures on the person\'s leases', async () => {
    const exported = await call('GET', '/me/data-export', { sub: 'sub-tenant', groups: 'tenant' });
    expect(exported.status).toBe(200);
    for (const section of ['maintenanceRequests', 'maintenanceUpdates', 'maintenancePhotos', 'inspections', 'signatures', 'endOfTenancy', 'arrears', 'renewals', 'invitations']) {
      expect(exported.body, section).toHaveProperty(section);
    }
  });
});

describe('application documents', () => {
  it('deletes the file a replacement supersedes, and an upload it refuses', async () => {
    const as = await register('Replacing Person', 'replace@example.co.za');
    const made = await apply(as, { email: 'replace@example.co.za', unitId: otherUnit });
    expect(made.status).toBe(201);
    const id = made.body.id as string;
    const key = (n: number) => `applications/${id}/id_copy/00000000-0000-4000-8000-00000000000${n}.pdf`;
    const pdf = new TextEncoder().encode('%PDF-1.4 test');

    await storage.storage().put(key(1), pdf, 'application/pdf');
    expect((await call('POST', `/applications/${id}/documents/confirm`, as, { key: key(1) })).status).toBe(200);
    await storage.storage().put(key(2), pdf, 'application/pdf');
    expect((await call('POST', `/applications/${id}/documents/confirm`, as, { key: key(2) })).status).toBe(200);

    expect(existsSync(storage.localPathFor(key(1)))).toBe(false);
    expect(existsSync(storage.localPathFor(key(2)))).toBe(true);
    const rows = await db.query<{ s3_key: string }>('select s3_key from application_document where application_id = $1', [id]);
    expect(rows.map((row) => row.s3_key)).toEqual([key(2)]);

    await storage.storage().put(key(3), new TextEncoder().encode('not a document'), 'application/pdf');
    expect((await call('POST', `/applications/${id}/documents/confirm`, as, { key: key(3) })).status).toBe(400);
    expect(existsSync(storage.localPathFor(key(3)))).toBe(false);
  });
});
