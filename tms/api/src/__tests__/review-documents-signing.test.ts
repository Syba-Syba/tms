import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const LEASE = '66666666-6666-6666-6666-666666666666';

// A real 1x1 PNG, which pdf-lib decodes.
const ONE_PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const SIGNATURE = `data:image/png;base64,${ONE_PX}`;
// A JPEG header and nothing behind it: passes a magic-byte sniff, fails to embed.
const BROKEN_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array(150).fill(0)]);

/**
 * Review findings on the signed documents: a render or seal never overwrites a document a
 * stored hash names, a photo cannot join a report after its draft was fingerprinted, a photo
 * that cannot be decoded is refused, and a client cannot record an OTP that never existed.
 */
type Opts = { sub?: string; groups?: string; body?: unknown };
let call: (method: string, path: string, opts?: Opts) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let store: import('../lib/storage').Storage;

const asTenant: Opts = { sub: 'sub-tenant', groups: 'tenant' };
const today = () => new Date().toISOString().slice(0, 10);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://review-docs-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'tms-review-docs-'));
  process.env.KMS_DRIVER = 'local';

  db = await import('../lib/db');
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  for (const file of all.filter((n) => !n.includes('seed'))) await db.execScript(read(file));
  for (const file of all.filter((n) => n.includes('seed'))) await db.execScript(read(file));

  store = (await import('../lib/storage')).storage();
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

// Puts go through a hook a test can arm for one matching key.
let hook: { match: RegExp; run: () => Promise<void> } | null = null;
beforeAll(() => {
  const put = store.put.bind(store);
  store.put = async (key, body, contentType) => {
    const armed = hook;
    if (armed && armed.match.test(key)) {
      hook = null;
      await armed.run();
    }
    return put(key, body, contentType);
  };
});

afterEach(() => {
  hook = null;
  vi.useRealTimers();
});

// pdf-lib stamps the creation time, so moving the clock makes a re-render differ in bytes.
const moveClock = (seconds: number) => {
  const now = Date.now();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now + seconds * 1000);
};

// A lease holds one inspection of each kind, so each case clears the last one first.
const newInspection = async () => {
  await db.query(`delete from deposit_deduction where finding_id in
    (select f.id from inspection_finding f join inspection i on i.id = f.inspection_id where i.lease_id = $1)`, [LEASE]);
  await db.query(`delete from inspection where lease_id = $1 and kind = 'incoming'`, [LEASE]);
  const created = await call('POST', `/leases/${LEASE}/inspections`, {
    body: { kind: 'incoming', scheduledFor: today() },
  });
  expect(created.status).toBe(201);
  return created.body.id as string;
};

const sign = (inspectionId: string, party: 'landlord' | 'tenant', pdfSha256: string) =>
  call('POST', `/inspections/${inspectionId}/signature`, {
    ...(party === 'tenant' ? asTenant : {}),
    body: { party, signatureBase64: SIGNATURE, pdfSha256 },
  });

const presign = async (inspectionId: string) => {
  const presigned = await call('POST', `/inspections/${inspectionId}/photos/presign`, {
    body: { room: 'Kitchen', item: 'Sink and taps', contentType: 'image/png', sizeBytes: 70 },
  });
  expect(presigned.status).toBe(201);
  return presigned.body as { photoId: string; key: string };
};

const confirm = (photoId: string) => call('POST', '/photos/confirm', { body: { scope: 'inspection', photoId } });

describe('photos and the inspection draft', () => {
  it('refuses a photo confirmed after the draft was signed', async () => {
    const inspectionId = await newInspection();
    const photo = await presign(inspectionId);
    const draft = await call('POST', `/inspections/${inspectionId}/render`);
    expect((await sign(inspectionId, 'landlord', draft.body.sha256)).status).toBe(200);

    await store.put(photo.key, Buffer.from(ONE_PX, 'base64'), 'image/png');
    const late = await confirm(photo.photoId);
    expect(late.status).toBe(409);
    const [row] = await db.query<{ uploaded: boolean }>('select uploaded from inspection_photo where id = $1', [
      photo.photoId,
    ]);
    expect(row!.uploaded).toBe(false);

    // The tenant signs the same draft, and the sealed report carries no photo nobody saw.
    expect((await sign(inspectionId, 'tenant', draft.body.sha256)).status).toBe(200);
  });

  it('withdraws the draft fingerprint when a photo is confirmed', async () => {
    const inspectionId = await newInspection();
    const photo = await presign(inspectionId);
    const draft = await call('POST', `/inspections/${inspectionId}/render`);
    await store.put(photo.key, Buffer.from(ONE_PX, 'base64'), 'image/png');
    expect((await confirm(photo.photoId)).status).toBe(200);

    const [row] = await db.query<{ draft_sha256: string | null }>(
      'select draft_sha256 from inspection where id = $1',
      [inspectionId],
    );
    expect(row!.draft_sha256).toBeNull();
    expect((await sign(inspectionId, 'landlord', draft.body.sha256)).status).toBe(409);
  });

  it('keeps the confirmed bytes when the upload link is used again afterwards', async () => {
    const inspectionId = await newInspection();
    const photo = await presign(inspectionId);
    const original = Buffer.from(ONE_PX, 'base64');
    await store.put(photo.key, original, 'image/png');
    expect((await confirm(photo.photoId)).status).toBe(200);

    // The link is still live for a few minutes; a second PUT to it lands on the old key only.
    await store.put(photo.key, Buffer.from('not the photo that was checked'), 'image/png');
    const [row] = await db.query<{ s3_key: string }>('select s3_key from inspection_photo where id = $1', [
      photo.photoId,
    ]);
    expect(row!.s3_key).not.toBe(photo.key);
    expect(Buffer.from(await store.get(row!.s3_key)).equals(original)).toBe(true);

    // A repeated confirm is a retry and leaves the kept copy alone.
    expect((await confirm(photo.photoId)).status).toBe(200);
    const [again] = await db.query<{ s3_key: string }>('select s3_key from inspection_photo where id = $1', [
      photo.photoId,
    ]);
    expect(again!.s3_key).toBe(row!.s3_key);
  });

  it('does not fingerprint a draft that a findings save raced', async () => {
    const inspectionId = await newInspection();
    hook = {
      match: new RegExp(`inspections/${inspectionId}/draft`),
      run: async () => {
        const saved = await call('PUT', `/inspections/${inspectionId}/findings`, {
          body: { findings: [{ room: 'Kitchen', item: 'Sink and taps', condition: 'damaged', note: 'Cracked' }] },
        });
        expect(saved.status).toBe(200);
      },
    };
    const raced = await call('POST', `/inspections/${inspectionId}/render`);
    expect(raced.status).toBe(409);
    const [row] = await db.query<{ draft_sha256: string | null }>(
      'select draft_sha256 from inspection where id = $1',
      [inspectionId],
    );
    expect(row!.draft_sha256).toBeNull();
    expect((await call('POST', `/inspections/${inspectionId}/render`)).status).toBe(200);
  });
});

describe('a photo that cannot be decoded', () => {
  it('is refused at confirm even with a JPEG header', async () => {
    const inspectionId = await newInspection();
    const photo = await presign(inspectionId);
    await store.put(photo.key, BROKEN_JPEG, 'image/jpeg');
    const refused = await confirm(photo.photoId);
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toMatch(/could not be read/);
    expect((await call('POST', `/inspections/${inspectionId}/render`)).status).toBe(200);
  });

  it('already on file is left out of the report rather than failing it', async () => {
    const inspectionId = await newInspection();
    const photo = await presign(inspectionId);
    await store.put(photo.key, BROKEN_JPEG, 'image/jpeg');
    await db.query('update inspection_photo set uploaded = true where id = $1', [photo.photoId]);
    const draft = await call('POST', `/inspections/${inspectionId}/render`);
    expect(draft.status).toBe(200);
    expect((await sign(inspectionId, 'landlord', draft.body.sha256)).status).toBe(200);
    expect((await sign(inspectionId, 'tenant', draft.body.sha256)).status).toBe(200);
  });
});

describe('sealing the inspection report', () => {
  it('keeps the stored report matching its hash when a repeat signature seals alongside', async () => {
    const inspectionId = await newInspection();
    const draft = await call('POST', `/inspections/${inspectionId}/render`);
    expect((await sign(inspectionId, 'landlord', draft.body.sha256)).status).toBe(200);

    // The first seal's put waits while a repeat signature runs a whole second seal.
    hook = {
      match: new RegExp(`inspections/${inspectionId}/report`),
      run: async () => {
        moveClock(5);
        expect((await sign(inspectionId, 'landlord', draft.body.sha256)).status).toBe(200);
      },
    };
    expect((await sign(inspectionId, 'tenant', draft.body.sha256)).status).toBe(200);

    const [row] = await db.query<{ status: string; pdf_s3_key: string; pdf_sha256: string }>(
      'select status, pdf_s3_key, pdf_sha256 from inspection where id = $1',
      [inspectionId],
    );
    expect(row!.status).toBe('completed');
    expect(sha(await store.get(row!.pdf_s3_key))).toBe(row!.pdf_sha256);
  });
});

describe('the lease document', () => {
  it('is not overwritten by a render that a signature beat', async () => {
    expect((await call('POST', `/leases/${LEASE}/render`)).status).toBe(200);
    const [first] = await db.query<{ pdf_sha256: string }>('select pdf_sha256 from lease where id = $1', [LEASE]);

    // The signature lands while the second render is in flight, before its put.
    hook = {
      match: new RegExp(`leases/${LEASE}/lease`),
      run: async () => {
        await db.query(
          `insert into lease_signature (lease_id, party, signature_s3_key, pdf_sha256)
           values ($1, 'tenant', 'leases/x/signature-tenant.png', $2)`,
          [LEASE, first!.pdf_sha256],
        );
      },
    };
    moveClock(5);
    const raced = await call('POST', `/leases/${LEASE}/render`);
    expect(raced.status).toBe(409);

    const [row] = await db.query<{ pdf_s3_key: string; pdf_sha256: string }>(
      'select pdf_s3_key, pdf_sha256 from lease where id = $1',
      [LEASE],
    );
    expect(row!.pdf_sha256).toBe(first!.pdf_sha256);
    expect(sha(await store.get(row!.pdf_s3_key))).toBe(first!.pdf_sha256);
    await db.query('delete from lease_signature where lease_id = $1', [LEASE]);
  });

  it('never records an OTP the client claims to have verified', async () => {
    const [before] = await db.query<{ status: string }>('select status from lease where id = $1', [LEASE]);
    await db.query('delete from lease_signature where lease_id = $1', [LEASE]);
    await db.query("update lease set status = 'out_for_signature' where id = $1", [LEASE]);
    const lease = await call('GET', `/leases/${LEASE}`, asTenant);
    const signed = await call('POST', `/leases/${LEASE}/signature`, {
      ...asTenant,
      body: { party: 'tenant', signatureBase64: SIGNATURE, pdfSha256: lease.body.pdfSha256, otpVerified: true },
    });
    expect(signed.status).toBe(200);
    const [row] = await db.query<{ otp_verified: boolean }>(
      "select otp_verified from lease_signature where lease_id = $1 and party = 'tenant'",
      [LEASE],
    );
    expect(row!.otp_verified).toBe(false);
    await db.query('delete from lease_signature where lease_id = $1', [LEASE]);
    await db.query('update lease set status = $2 where id = $1', [LEASE, before!.status]);
  });
});
