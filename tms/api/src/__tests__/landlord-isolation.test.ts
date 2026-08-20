import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

/**
 * The lease routes have checked property ownership since the July audit. The application and
 * document routes had not: they accepted membership of the `landlord` group as proof, which
 * holds only while exactly one landlord exists. The README describes that deployment, but the
 * schema models many, and nothing failed when a second appeared.
 *
 * Every test here seeds a second landlord and asserts the first cannot reach their applicant.
 * The single-landlord seed cannot exercise any of this, which is why it went unnoticed.
 */

let call: (
  method: string,
  path: string,
  opts?: { sub?: string; groups?: string; body?: unknown; query?: Record<string, string> },
) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');

const OTHER_LANDLORD_SUB = 'sub-landlord-two';
const OTHER_APPLICANT_SUB = 'sub-applicant-two';
let otherApplicationId: string;
let otherUnitId: string;

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://isolation-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'tms-isolation-'));
  process.env.KMS_DRIVER = 'local';

  db = await import('../lib/db');
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  const all = readdirSync(MIGRATIONS)
    .filter((n) => n.endsWith('.sql'))
    .sort();
  for (const file of all.filter((n) => !n.includes('seed'))) await db.execScript(read(file));
  for (const file of all.filter((n) => n.includes('seed'))) await db.execScript(read(file));

  // A second landlord, with their own property, unit and applicant. Nothing links them to the
  // seeded landlord beyond both being in the `landlord` group.
  const [landlord] = await db.query<{ id: string }>(
    `insert into landlord (trading_name, email, phone, cognito_sub)
     values ('Dlamini Rentals', 'two@example.co.za', '+27829999999', $1) returning id`,
    [OTHER_LANDLORD_SUB],
  );
  const [property] = await db.query<{ id: string }>(
    `insert into property (landlord_id, name, address_line1, suburb, city, province, postal_code)
     values ($1, 'Second Court', '9 Other Road', 'Parkview', 'Johannesburg', 'Gauteng', '2193')
     returning id`,
    [landlord!.id],
  );
  const [unit] = await db.query<{ id: string }>(
    `insert into unit (property_id, code, bedrooms, bathrooms, monthly_rent_cents, deposit_cents)
     values ($1, 'B1', 1, 1, 700000, 700000) returning id`,
    [property!.id],
  );
  otherUnitId = unit!.id;
  const [applicant] = await db.query<{ id: string }>(
    `insert into applicant (cognito_sub, first_name, last_name, id_number_enc, id_number_last4,
                            email, phone, employment_status, monthly_income_cents)
     values ($1, 'Thandi', 'Dlamini', '\\x00', '1234', 'thandi@example.co.za',
             '0821234567', 'employed', 2800000) returning id`,
    [OTHER_APPLICANT_SUB],
  );
  const [application] = await db.query<{ id: string }>(
    `insert into application (unit_id, applicant_id, status, preferred_move_in, occupants)
     values ($1, $2, 'submitted', '2027-01-01', 1) returning id`,
    [otherUnitId, applicant!.id],
  );
  otherApplicationId = application!.id;

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
          jwt: {
            claims: {
              sub: opts.sub ?? 'sub-landlord',
              'cognito:groups': `[${opts.groups ?? 'landlord'}]`,
            },
          },
        },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
    const result = (await handler(event)) as { statusCode: number; body?: string };
    return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : null };
  };
}, 120_000);

afterAll(() => undefined);

const asOther = { sub: OTHER_LANDLORD_SUB, groups: 'landlord' };

describe('the applications queue is scoped to the landlord who owns the property', () => {
  it('shows a landlord only their own applications', async () => {
    const mine = await call('GET', '/applications', { query: { status: 'all' } });
    expect(mine.status).toBe(200);
    const ids = mine.body.items.map((item: { id: string }) => item.id);
    expect(ids).not.toContain(otherApplicationId);
  });

  it('shows the second landlord their own, and only theirs', async () => {
    const theirs = await call('GET', '/applications', {
      ...asOther,
      query: { status: 'all' },
    });
    expect(theirs.status).toBe(200);
    const ids = theirs.body.items.map((item: { id: string }) => item.id);
    expect(ids).toEqual([otherApplicationId]);
  });

  it('refuses a landlord with no landlord profile behind their sign-in', async () => {
    const response = await call('GET', '/applications', {
      sub: 'sub-nobody',
      groups: 'landlord',
      query: { status: 'all' },
    });
    expect(response.status).toBe(403);
  });
});

describe("a landlord cannot act on another landlord's application", () => {
  it('refuses to decide it', async () => {
    const response = await call('POST', `/applications/${otherApplicationId}/decision`, {
      body: { outcome: 'declined', reason: 'Not for me to say.' },
    });
    expect(response.status).toBe(403);

    // The decision really did not land.
    const [row] = await db.query<{ status: string }>(
      'select status from application where id = $1',
      [otherApplicationId],
    );
    expect(row!.status).toBe('submitted');
  });

  it('refuses to generate a lease against it', async () => {
    const response = await call('POST', `/applications/${otherApplicationId}/lease`, {
      body: { startDate: '2027-01-01', months: 12, escalationPct: 8 },
    });
    expect(response.status).toBe(403);

    const rows = await db.query<{ id: string }>(
      'select id from lease where application_id = $1',
      [otherApplicationId],
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses to read its documents', async () => {
    // ID copies, payslips and bank statements. A 404 rather than a 403, so the response does
    // not confirm the application exists.
    const response = await call('GET', `/applications/${otherApplicationId}/documents`);
    expect(response.status).toBe(404);
  });

  it('refuses to attach a document to it', async () => {
    const response = await call('POST', `/applications/${otherApplicationId}/documents/presign`, {
      body: { kind: 'payslip', contentType: 'application/pdf', sizeBytes: 1000 },
    });
    expect(response.status).toBe(403);
  });

  it('refuses to swap its stored document key for a signed URL', async () => {
    const [document] = await db.query<{ s3_key: string }>(
      `insert into application_document (application_id, kind, s3_key, content_type, size_bytes)
       values ($1, 'payslip', $2, 'application/pdf', 1000) returning s3_key`,
      [otherApplicationId, `applications/${otherApplicationId}/payslip/leaked.pdf`],
    );

    const response = await call('POST', '/files/view', { body: { key: document!.s3_key } });
    expect(response.status).toBe(404);

    // The owning landlord still gets their own file.
    const owner = await call('POST', '/files/view', {
      ...asOther,
      body: { key: document!.s3_key },
    });
    expect(owner.status).toBe(200);
    expect(owner.body.viewUrl).toContain('/files/');
  });
});

describe('the applicant still reaches their own application', () => {
  it('reads their own documents', async () => {
    const response = await call('GET', `/applications/${otherApplicationId}/documents`, {
      sub: OTHER_APPLICANT_SUB,
      groups: 'tenant',
    });
    expect(response.status).toBe(200);
  });

  it('cannot decide their own application', async () => {
    const response = await call('POST', `/applications/${otherApplicationId}/decision`, {
      sub: OTHER_APPLICANT_SUB,
      groups: 'tenant',
      body: { outcome: 'approved' },
    });
    expect(response.status).toBe(403);
  });
});

describe('the owning landlord is unaffected', () => {
  it('decides their own application', async () => {
    const response = await call('POST', `/applications/${otherApplicationId}/decision`, {
      ...asOther,
      body: { outcome: 'approved' },
    });
    expect(response.status).toBe(200);
  });

  it('generates the lease for it', async () => {
    const response = await call('POST', `/applications/${otherApplicationId}/lease`, {
      ...asOther,
      body: { startDate: '2027-01-01', months: 12, escalationPct: 8 },
    });
    expect(response.status).toBe(201);
  });
});
