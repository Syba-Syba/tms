import { beforeAll, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TERMS_VERSION } from '../domain/company';
import { PRIVACY_VERSION } from '../domain/privacy';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const ONE_PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

type As = { sub: string; groups: string };
const NOBODY: As = { sub: 'anonymous', groups: 'tenant' };
const OWNER: As = { sub: 'sub-landlord', groups: 'landlord' };
let other: As;
let call: (method: string, path: string, as: As, body?: unknown) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let storage: typeof import('../lib/storage');
let unitId: string;
let occupiedId: string;

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://listings-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.AUTH_DRIVER = 'local';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'tms-listings-'));
  process.env.KMS_DRIVER = 'local';
  db = await import('../lib/db');
  storage = await import('../lib/storage');
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  for (const file of all.filter((n) => !n.includes('seed'))) await db.execScript(read(file));
  for (const file of all.filter((n) => n.includes('seed'))) await db.execScript(read(file));
  const { handler } = await import('../api');
  let ip = 0;
  call = async (method, path, as, body) => {
    const [rawPath, search = ''] = path.split('?');
    const event = {
      rawPath,
      headers: { 'content-type': 'application/json' },
      queryStringParameters: Object.fromEntries(new URLSearchParams(search)),
      pathParameters: {},
      body: body === undefined ? undefined : JSON.stringify(body),
      requestContext: {
        http: { method, path: rawPath, sourceIp: `10.71.0.${(ip++ % 250) + 1}`, userAgent: 'test' },
        authorizer: { jwt: { claims: { sub: as.sub, 'cognito:groups': `[${as.groups}]` } } },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
    const result = (await handler(event)) as { statusCode: number; body?: string };
    return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : null };
  };

  const units = await db.query<{ id: string; status: string }>(
    `select u.id, u.status from unit u join property p on p.id = u.property_id
       join landlord_member m on m.landlord_id = p.landlord_id where m.sub = 'sub-landlord' order by u.code`,
  );
  unitId = units.find((unit) => unit.status === 'vacant')!.id;
  occupiedId = units.find((unit) => unit.status === 'occupied')!.id;

  const signed = await call('POST', '/auth/register', NOBODY, {
    name: 'Other Owner', email: 'other-listings@example.co.za', password: 'a-long-password',
    consentVersion: PRIVACY_VERSION, termsVersion: TERMS_VERSION,
    landlord: { tradingName: 'Other Rentals', phone: '0825552020' },
  });
  expect(signed.status).toBe(201);
  other = { sub: signed.body.user.sub, groups: 'landlord' };
}, 120_000);

const upload = async (as: As, unit: string) => {
  const presigned = await call('POST', `/units/${unit}/photos`, as, { contentType: 'image/png', sizeBytes: 70 });
  if (presigned.status !== 201) return { presigned, confirmed: null };
  await storage.storage().put(presigned.body.key, Buffer.from(ONE_PX, 'base64'), 'image/png');
  const confirmed = await call('POST', '/photos/confirm', as, { scope: 'unit', photoId: presigned.body.photoId });
  return { presigned, confirmed };
};

const listing = async () => (await call('GET', '/listings?landlord=mokoena-properties', NOBODY)).body;

describe('listing details', () => {
  it('saves the description and features, and refuses a bad date', async () => {
    const saved = await call('PUT', `/units/${unitId}`, OWNER, {
      description: 'Sunny two-bed with a garden.', availableFrom: '2026-12-01', furnished: true, petsAllowed: true, parkingBays: 2,
    });
    expect(saved.status).toBe(200);
    expect((await call('PUT', `/units/${unitId}`, OWNER, { availableFrom: '1 December' })).status).toBe(400);
    expect((await call('PUT', `/units/${unitId}`, OWNER, { parkingBays: 11 })).status).toBe(400);
  });
});

describe('listing photos', () => {
  it('uploads, checks and keeps a photo, and shows it to the owner', async () => {
    const { confirmed } = await upload(OWNER, unitId);
    expect(confirmed!.status).toBe(200);
    expect(confirmed!.body.key).toMatch(/\.kept\.png$/);
    const properties = await call('GET', '/properties', OWNER);
    const unit = properties.body.items.flatMap((p: any) => p.units).find((u: any) => u.id === unitId);
    expect(unit.listing.photos).toHaveLength(1);
    expect(unit.listing).toMatchObject({ furnished: true, petsAllowed: true, parkingBays: 2, availableFrom: '2026-12-01' });
  });

  it('refuses a file that is not a photo', async () => {
    const presigned = await call('POST', `/units/${unitId}/photos`, OWNER, { contentType: 'image/jpeg', sizeBytes: 70 });
    await storage.storage().put(presigned.body.key, Buffer.from('not a photo at all'), 'image/jpeg');
    const confirmed = await call('POST', '/photos/confirm', OWNER, { scope: 'unit', photoId: presigned.body.photoId });
    expect(confirmed.status).toBe(400);
    await db.query('delete from unit_photo where id = $1', [presigned.body.photoId]);
  });

  it("keeps another landlord out of this landlord's units and photos", async () => {
    expect((await upload(other, unitId)).presigned.status).toBe(404);
    const [photo] = await db.query<{ id: string }>('select id from unit_photo where unit_id = $1', [unitId]);
    expect((await call('POST', '/photos/confirm', other, { scope: 'unit', photoId: photo!.id })).status).toBe(404);
    expect((await call('DELETE', `/units/${unitId}/photos/${photo!.id}`, other)).status).toBe(404);
    // A tenant cannot reach the landlord's listing tools either.
    expect((await call('POST', `/units/${unitId}/photos`, { sub: 'sub-tenant', groups: 'tenant' }, { contentType: 'image/png', sizeBytes: 70 })).status).toBe(403);
  });

  it('holds at most twelve photos a listing', async () => {
    await db.query(
      `insert into unit_photo (unit_id, s3_key, content_type, size_bytes, uploaded)
       select $1, 'units/filler-' || n, 'image/png', 70, true from generate_series(1, 11) n`,
      [unitId],
    );
    expect((await call('POST', `/units/${unitId}/photos`, OWNER, { contentType: 'image/png', sizeBytes: 70 })).status).toBe(409);
    await db.query(`delete from unit_photo where s3_key like 'units/filler-%'`);
  });
});

describe('the public listings page', () => {
  it('shows vacant, listed units with photos to anyone, and nothing about tenants', async () => {
    const page = await listing();
    expect(page.landlord.name).toBe('Mokoena Properties');
    const unit = page.items.find((item: any) => item.id === unitId);
    expect(unit).toMatchObject({ description: 'Sunny two-bed with a garden.', furnished: true, parkingBays: 2 });
    expect(unit.photos).toHaveLength(1);
    expect(page.items.some((item: any) => item.id === occupiedId)).toBe(false);
    const text = JSON.stringify(page);
    expect(text).not.toMatch(/Naledi|Sipho|addressLine|tenant/i);
  });

  it('can take a unit off the page', async () => {
    expect((await call('PUT', `/units/${unitId}`, OWNER, { listed: false })).status).toBe(200);
    expect((await listing()).items.some((item: any) => item.id === unitId)).toBe(false);
    expect((await call('PUT', `/units/${unitId}`, OWNER, { listed: true })).status).toBe(200);
  });

  it('answers a wrong link plainly', async () => {
    expect((await call('GET', '/listings?landlord=nobody-here', NOBODY)).status).toBe(404);
    expect((await call('GET', '/listings?landlord=../etc', NOBODY)).status).toBe(400);
    expect((await call('GET', '/listings', NOBODY)).status).toBe(400);
  });

  it('drops a removed photo from the page and from storage', async () => {
    const [photo] = await db.query<{ id: string; s3_key: string }>('select id, s3_key from unit_photo where unit_id = $1', [unitId]);
    expect((await call('DELETE', `/units/${unitId}/photos/${photo!.id}`, OWNER)).status).toBe(200);
    expect(await storage.storage().sizeOf(photo!.s3_key)).toBeNull();
    expect((await listing()).items.find((item: any) => item.id === unitId).photos).toHaveLength(0);
    expect((await call('DELETE', `/units/${unitId}/photos/not-an-id`, OWNER)).status).toBe(404);
  });
});
