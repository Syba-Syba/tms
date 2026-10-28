import { PRIVACY_VERSION } from '../domain/privacy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

/**
 * The features added after the audit, end to end through the real router: portfolio
 * management, the contractor directory, application documents, the inspection draft-and-sign
 * flow, and the local storage driver that makes all of it work without AWS.
 */
let call: (
  method: string,
  path: string,
  opts?: { sub?: string; groups?: string; body?: unknown },
) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let storageLib: typeof import('../lib/storage');

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://portfolio-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'tms-storage-'));
  process.env.KMS_DRIVER = 'local';

  db = await import('../lib/db');
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  for (const file of all.filter((n) => !n.includes('seed'))) await db.execScript(read(file));
  for (const file of all.filter((n) => n.includes('seed'))) await db.execScript(read(file));

  storageLib = await import('../lib/storage');
  const { handler } = await import('../api');
  call = async (method, fullPath, opts = {}) => {
    const [path = fullPath, search] = fullPath.split('?');
    const event = {
      rawPath: path,
      headers: { 'content-type': 'application/json' },
      queryStringParameters: Object.fromEntries(new URLSearchParams(search ?? '')),
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

// The in-memory database dies with the worker; there is no pool to close.

const LEASE = '66666666-6666-6666-6666-666666666666';

describe('portfolio', () => {
  it('shows the landlord every unit with its tenancy', async () => {
    const response = await call('GET', '/properties');
    expect(response.status).toBe(200);
    const kruis = response.body.items.find((p: any) => p.name === 'Kruis Court');
    expect(kruis.units).toHaveLength(3);
    const occupied = kruis.units.find((u: any) => u.code === 'A1');
    expect(occupied.status).toBe('occupied');
    expect(occupied.tenant).toBe('Naledi Phiri');
    expect(occupied.leaseId).toBe(LEASE);
    const waiting = kruis.units.find((u: any) => u.code === 'A2');
    expect(waiting.openApplications).toBe(1);
  });

  it('is landlord only', async () => {
    const response = await call('GET', '/properties', { sub: 'sub-tenant', groups: 'tenant' });
    expect(response.status).toBe(403);
  });

  it('creates a property and a unit that then shows as vacant', async () => {
    const property = await call('POST', '/properties', {
      body: {
        name: 'Hill Street',
        addressLine1: '9 Hill Street',
        suburb: 'Linden',
        city: 'Johannesburg',
        province: 'Gauteng',
        postalCode: '2195',
      },
    });
    expect(property.status).toBe(201);
    const unit = await call('POST', `/properties/${property.body.id}/units`, {
      body: { code: 'G1', bedrooms: 2, bathrooms: 1, monthlyRentCents: 900000, depositCents: 900000 },
    });
    expect(unit.status).toBe(201);

    const list = await call('GET', '/properties');
    const hill = list.body.items.find((p: any) => p.name === 'Hill Street');
    expect(hill.units[0]).toMatchObject({ code: 'G1', status: 'vacant', tenant: null });
  });

  it('rejects a duplicate unit code at the same property', async () => {
    const list = await call('GET', '/properties');
    const kruis = list.body.items.find((p: any) => p.name === 'Kruis Court');
    const response = await call('POST', `/properties/${kruis.id}/units`, {
      body: { code: 'A1', bedrooms: 1, bathrooms: 1, monthlyRentCents: 500000, depositCents: 0 },
    });
    expect(response.status).toBe(409);
  });

  it('re-prices the listing without touching the signed lease', async () => {
    const list = await call('GET', '/properties');
    const kruis = list.body.items.find((p: any) => p.name === 'Kruis Court');
    const occupied = kruis.units.find((u: any) => u.code === 'A1');
    const response = await call('PUT', `/units/${occupied.id}`, {
      body: { monthlyRentCents: 999900 },
    });
    expect(response.status).toBe(200);

    const lease = await call('GET', `/leases/${LEASE}`);
    expect(lease.body.monthlyRentCents).toBe(850000);
  });

  it('never lets one landlord edit another landlord\'s stock', async () => {
    const other = await db.query<{ id: string }>(
      `insert into landlord (trading_name, email, phone, cognito_sub)
       values ('Someone Else', 'other@example.co.za', '0800000000', 'sub-other-landlord')
       returning id`,
    );
    const property = await db.query<{ id: string }>(
      `insert into property (landlord_id, name, address_line1, suburb, city, province, postal_code)
       values ($1, 'Not Yours', '1 Far Road', 'Far', 'Cape Town', 'Western Cape', '8001')
       returning id`,
      [other[0]!.id],
    );
    const response = await call('PUT', `/properties/${property[0]!.id}`, {
      body: { name: 'Mine Now' },
    });
    expect(response.status).toBe(404);
  });

  it('offers applicants only vacant units, and only the landlord\'s whose link they followed', async () => {
    // Two landlords now exist, so a bare request lists nothing rather than mixing their stock.
    const bare = await call('GET', '/units/available', { sub: 'sub-someone-new', groups: 'tenant' });
    expect(bare.body).toMatchObject({ needsLink: true, items: [] });
    const response = await call('GET', '/units/available?landlord=mokoena-properties', {
      sub: 'sub-someone-new',
      groups: 'tenant',
    });
    expect(response.status).toBe(200);
    expect(response.body.landlord).toEqual({ name: 'Mokoena Properties' });
    expect(response.body.items.some((u: any) => u.label.startsWith('Not Yours'))).toBe(false);
    const codes = response.body.items.map((u: any) => u.label);
    expect(codes).toContain('Kruis Court A2');
    expect(codes).toContain('Hill Street G1');
    expect(codes.some((label: string) => label.endsWith('A1'))).toBe(false);
  });
});

describe('contractor directory', () => {
  it('builds itself from assignments and counts the jobs', async () => {
    const ticket = await call('POST', `/leases/${LEASE}/tickets`, {
      sub: 'sub-tenant',
      groups: 'tenant',
      body: {
        title: 'Geyser leaking',
        description: 'Water dripping from the ceiling below the geyser.',
        category: 'plumbing',
        severity: 'urgent',
      },
    });
    expect(ticket.status).toBe(201);
    const assigned = await call('POST', `/tickets/${ticket.body.id}/actions`, {
      body: {
        action: 'assign',
        contractor: { name: 'Thabo Nkosi', trade: 'Plumber', phone: '0827771111' },
      },
    });
    expect(assigned.status).toBe(200);

    const directory = await call('GET', '/contractors');
    expect(directory.status).toBe(200);
    expect(directory.body.items[0]).toMatchObject({
      name: 'Thabo Nkosi',
      trade: 'Plumber',
      jobs: 1,
    });
  });

  it('is landlord only', async () => {
    const response = await call('GET', '/contractors', { sub: 'sub-tenant', groups: 'tenant' });
    expect(response.status).toBe(403);
  });
});

describe('local storage driver', () => {
  it('round-trips bytes and reports size', async () => {
    const store = storageLib.storage();
    await store.put('test/round-trip.pdf', new Uint8Array([1, 2, 3]), 'application/pdf');
    expect(await store.sizeOf('test/round-trip.pdf')).toBe(3);
    expect([...(await store.get('test/round-trip.pdf'))]).toEqual([1, 2, 3]);
    expect(await store.sizeOf('test/absent.pdf')).toBeNull();
  });

  it('signs links that expire and cannot be tampered with', () => {
    const future = Math.floor(Date.now() / 1000) + 60;
    const good = storageLib.localSignature('GET', 'a/b.pdf', future);
    expect(storageLib.verifyLocalSignature('GET', 'a/b.pdf', future, good)).toBe(true);
    expect(storageLib.verifyLocalSignature('PUT', 'a/b.pdf', future, good)).toBe(false);
    expect(storageLib.verifyLocalSignature('GET', 'a/other.pdf', future, good)).toBe(false);
    const past = Math.floor(Date.now() / 1000) - 1;
    const expired = storageLib.localSignature('GET', 'a/b.pdf', past);
    expect(storageLib.verifyLocalSignature('GET', 'a/b.pdf', past, expired)).toBe(false);
  });

  it('refuses keys that escape the storage directory', () => {
    expect(() => storageLib.localPathFor('../outside.txt')).toThrow();
  });
});

describe('documents come back out', () => {
  it('lets both parties open the lease PDF and nobody else', async () => {
    const rendered = await call('POST', `/leases/${LEASE}/render`);
    expect(rendered.status).toBe(200);
    expect(await storageLib.storage().sizeOf(rendered.body.key)).toBeGreaterThan(0);

    const tenant = await call('POST', '/files/view', {
      sub: 'sub-tenant',
      groups: 'tenant',
      body: { key: rendered.body.key },
    });
    expect(tenant.status).toBe(200);
    expect(tenant.body.viewUrl).toContain('/files/');

    const stranger = await call('POST', '/files/view', {
      sub: 'sub-nobody',
      groups: 'tenant',
      body: { key: rendered.body.key },
    });
    expect(stranger.status).toBe(404);
  });

  it('shows application documents to the applicant and the landlord only', async () => {
    const application = await call('POST', '/applications', {
      sub: 'sub-fresh-applicant',
      groups: 'tenant',
      body: {
        unitId: (await call('GET', '/units/available?landlord=mokoena-properties', { groups: 'tenant', sub: 'sub-fresh-applicant' }))
          .body.items.find((u: any) => u.label === 'Hill Street G1').id,
        firstName: 'Lerato',
        lastName: 'Dube',
        idNumber: '9001015009086',
        email: 'lerato@example.co.za',
        phone: '0825550000',
        employmentStatus: 'employed',
        monthlyIncomeCents: 4000000,
        occupants: 1,
        preferredMoveIn: '2099-01-01',
        consentVersion: PRIVACY_VERSION,
      },
    });
    expect(application.status).toBe(201);

    const presigned = await call('POST', `/applications/${application.body.id}/documents/presign`, {
      sub: 'sub-fresh-applicant',
      groups: 'tenant',
      body: { kind: 'payslip', contentType: 'application/pdf', sizeBytes: 1000 },
    });
    expect(presigned.status).toBe(201);
    // Standing in for the browser's direct upload.
    await storageLib.storage().put(
      presigned.body.key,
      new Uint8Array(Buffer.from('%PDF-1.4\n%%EOF\n', 'latin1')),
      'application/pdf',
    );
    // A document is on file only once its upload is confirmed.
    const confirmed = await call('POST', `/applications/${application.body.id}/documents/confirm`, {
      sub: 'sub-fresh-applicant',
      groups: 'tenant',
      body: { key: presigned.body.key },
    });
    expect(confirmed.status).toBe(200);

    const asLandlord = await call('GET', `/applications/${application.body.id}/documents`);
    expect(asLandlord.status).toBe(200);
    expect(asLandlord.body.items[0]).toMatchObject({ kind: 'payslip' });
    expect(asLandlord.body.items[0].viewUrl).toContain('/files/');

    const asOwner = await call('GET', `/applications/${application.body.id}/documents`, {
      sub: 'sub-fresh-applicant',
      groups: 'tenant',
    });
    expect(asOwner.status).toBe(200);

    const asOtherTenant = await call('GET', `/applications/${application.body.id}/documents`, {
      sub: 'sub-tenant',
      groups: 'tenant',
    });
    expect(asOtherTenant.status).toBe(404);
  });
});

describe('inspection walkthrough, draft and joint signing', () => {
  let inspectionId: string;
  // A real 1x1 PNG: the seal embeds these bytes into the report, so they must decode.
  const ONE_PX =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const SIGNATURE = `data:image/png;base64,${ONE_PX}`;

  it('opens with the seeded findings visible to both parties', async () => {
    const created = await call('POST', `/leases/${LEASE}/inspections`, {
      body: { kind: 'incoming', scheduledFor: new Date().toISOString().slice(0, 10) },
    });
    expect(created.status).toBe(201);
    inspectionId = created.body.id;

    const state = await call('GET', `/inspections/${inspectionId}`, {
      sub: 'sub-tenant',
      groups: 'tenant',
    });
    expect(state.status).toBe(200);
    expect(state.body.findings.length).toBeGreaterThan(10);
    expect(state.body.viewer.isTenant).toBe(true);
    // Two bedrooms on the seeded unit means two seeded bedroom blocks.
    const rooms = new Set(state.body.findings.map((f: any) => f.room));
    expect(rooms.has('Bedroom 1')).toBe(true);
    expect(rooms.has('Bedroom 2')).toBe(true);
  });

  it('refuses a signature before the report exists', async () => {
    const response = await call('POST', `/inspections/${inspectionId}/signature`, {
      body: { party: 'landlord', signatureBase64: SIGNATURE, pdfSha256: 'f'.repeat(64) },
    });
    expect(response.status).toBe(409);
  });

  it('renders a draft, takes both signatures against it, and seals the report', async () => {
    const draft = await call('POST', `/inspections/${inspectionId}/render`);
    expect(draft.status).toBe(200);
    expect(draft.body.sha256).toHaveLength(64);

    const stale = await call('POST', `/inspections/${inspectionId}/signature`, {
      body: { party: 'landlord', signatureBase64: SIGNATURE, pdfSha256: 'f'.repeat(64) },
    });
    expect(stale.status).toBe(409);

    const landlord = await call('POST', `/inspections/${inspectionId}/signature`, {
      body: { party: 'landlord', signatureBase64: SIGNATURE, pdfSha256: draft.body.sha256 },
    });
    expect(landlord.status).toBe(200);

    const tenant = await call('POST', `/inspections/${inspectionId}/signature`, {
      sub: 'sub-tenant',
      groups: 'tenant',
      body: { party: 'tenant', signatureBase64: SIGNATURE, pdfSha256: draft.body.sha256 },
    });
    expect(tenant.status).toBe(200);

    const state = await call('GET', `/inspections/${inspectionId}`);
    expect(state.body.status).toBe('completed');
    expect(state.body.signatures).toHaveLength(2);
    expect(state.body.reportKey).toBeTruthy();

    const view = await call('POST', '/files/view', {
      sub: 'sub-tenant',
      groups: 'tenant',
      body: { key: state.body.reportKey },
    });
    expect(view.status).toBe(200);
  });
});

describe('the remaining buttons', () => {
  it('renders an invoice PDF for the tenant and serves it back', async () => {
    const [invoice] = await db.query<{ id: string }>(
      `insert into invoice (lease_id, period_start, due_on, total_cents)
       values ($1, '2026-10-01', '2026-10-01', 850000) returning id`,
      [LEASE],
    );
    await db.query(
      `insert into invoice_line (invoice_id, kind, description, amount_cents)
       values ($1, 'rent', 'Rent for October 2026', 850000)`,
      [invoice!.id],
    );

    const rendered = await call('POST', `/invoices/${invoice!.id}/render`, {
      sub: 'sub-tenant',
      groups: 'tenant',
      body: {},
    });
    expect(rendered.status).toBe(200);

    const view = await call('POST', '/files/view', {
      sub: 'sub-tenant',
      groups: 'tenant',
      body: { key: rendered.body.key },
    });
    expect(view.status).toBe(200);
  });

  it('records, lists and removes a deduction, landlord only', async () => {
    const notice = await call('POST', `/leases/${LEASE}/termination`, {
      body: {
        initiatedBy: 'landlord',
        reason: 'end_of_term',
        noticeGivenOn: new Date().toISOString().slice(0, 10),
      },
    });
    expect(notice.status).toBe(201);
    const terminationId = notice.body.id;

    const added = await call('POST', `/terminations/${terminationId}/deductions`, {
      body: { description: 'Professional cleaning after handover', amountCents: 50000 },
    });
    expect(added.status).toBe(201);

    const listed = await call('GET', `/terminations/${terminationId}/comparison`);
    expect(listed.body.deductions).toHaveLength(1);
    const deductionId = listed.body.deductions[0].id;

    const tenantDelete = await call(
      'DELETE',
      `/terminations/${terminationId}/deductions/${deductionId}`,
      { sub: 'sub-tenant', groups: 'tenant' },
    );
    expect(tenantDelete.status).toBe(403);

    const removed = await call('DELETE', `/terminations/${terminationId}/deductions/${deductionId}`);
    expect(removed.status).toBe(200);
    const after = await call('GET', `/terminations/${terminationId}/comparison`);
    expect(after.body.deductions).toHaveLength(0);

    // Settling now would terminate a lease that runs for months yet; the guard refuses.
    const early = await call('POST', `/terminations/${terminationId}/settle`, { body: {} });
    expect(early.status).toBe(409);
    expect(early.body.error.message).toContain('moved out');
    const lease = await call('GET', `/leases/${LEASE}`);
    expect(lease.body.status).toBe('active');
  });
});

describe('removing properties and units', () => {
  it('removes an untouched unit and refuses one with history', async () => {
    const list = await call('GET', '/properties');
    const hill = list.body.items.find((p: any) => p.name === 'Hill Street');
    const spare = await call('POST', `/properties/${hill.id}/units`, {
      body: { code: 'TEMP', bedrooms: 1, bathrooms: 1, monthlyRentCents: 100000, depositCents: 0 },
    });
    expect(spare.status).toBe(201);

    const removed = await call('DELETE', `/units/${spare.body.id}`);
    expect(removed.status).toBe(200);

    const kruis = list.body.items.find((p: any) => p.name === 'Kruis Court');
    const occupied = kruis.units.find((u: any) => u.code === 'A1');
    const refused = await call('DELETE', `/units/${occupied.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain('lease history');
  });

  it('refuses a unit with applications on file', async () => {
    const list = await call('GET', '/properties');
    const kruis = list.body.items.find((p: any) => p.name === 'Kruis Court');
    const applied = kruis.units.find((u: any) => u.code === 'A2');
    const refused = await call('DELETE', `/units/${applied.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain('applied');
  });

  it('removes a property only once it is empty, scoped to its landlord', async () => {
    const created = await call('POST', '/properties', {
      body: {
        name: 'Short Lived',
        addressLine1: '1 Brief Lane',
        suburb: 'Melville',
        city: 'Johannesburg',
        province: 'Gauteng',
        postalCode: '2092',
      },
    });
    const unit = await call('POST', `/properties/${created.body.id}/units`, {
      body: { code: 'X1', bedrooms: 1, bathrooms: 1, monthlyRentCents: 100000, depositCents: 0 },
    });

    const whileFull = await call('DELETE', `/properties/${created.body.id}`);
    expect(whileFull.status).toBe(409);

    await call('DELETE', `/units/${unit.body.id}`);
    const asTenant = await call('DELETE', `/properties/${created.body.id}`, {
      sub: 'sub-tenant',
      groups: 'tenant',
    });
    expect(asTenant.status).toBe(403);

    const emptied = await call('DELETE', `/properties/${created.body.id}`);
    expect(emptied.status).toBe(200);

    const after = await call('GET', '/properties');
    expect(after.body.items.some((p: any) => p.name === 'Short Lived')).toBe(false);
  });
});
