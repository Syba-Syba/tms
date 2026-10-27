import { beforeAll, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const LEASE = '66666666-6666-6666-6666-666666666666';

// A real 1x1 PNG; the seal embeds it, so it must decode.
const ONE_PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const SIGNATURE = `data:image/png;base64,${ONE_PX}`;
const JPEG_AS_PNG = `data:image/png;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(120).fill(0)]).toString('base64')}`;

/**
 * The documents the parties sign: the report they fingerprint is the report they get, a
 * signed lease cannot be re-rendered from under its signatures, evidence keys are real photos
 * on the lease, and a landlord's ticket list is their own.
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
  process.env.PGLITE_DIR = `memory://docs-integrity-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'tms-docs-'));
  process.env.KMS_DRIVER = 'local';

  db = await import('../lib/db');
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  for (const file of all.filter((n) => !n.includes('seed'))) await db.execScript(read(file));
  for (const file of all.filter((n) => n.includes('seed'))) await db.execScript(read(file));

  storageLib = await import('../lib/storage');
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

const asTenant = { sub: 'sub-tenant', groups: 'tenant' };
const today = () => new Date().toISOString().slice(0, 10);

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

const sign = (inspectionId: string, party: 'landlord' | 'tenant', sha: string, signature = SIGNATURE) =>
  call('POST', `/inspections/${inspectionId}/signature`, {
    ...(party === 'tenant' ? asTenant : {}),
    body: { party, signatureBase64: signature, pdfSha256: sha },
  });

describe('inspection report integrity', () => {
  it('refuses a signature image that is not a PNG before storing anything', async () => {
    const inspectionId = await newInspection();
    const draft = await call('POST', `/inspections/${inspectionId}/render`);
    expect(draft.status).toBe(200);
    const refused = await sign(inspectionId, 'landlord', draft.body.sha256, JPEG_AS_PNG);
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toMatch(/not a PNG/);
    const stored = await storageLib.storage().sizeOf(`inspections/${inspectionId}/signature-landlord.png`);
    expect(stored).toBeNull();
    const [row] = await db.query<{ count: string }>(
      'select count(*)::text as count from inspection_signature where inspection_id = $1',
      [inspectionId],
    );
    expect(Number(row!.count)).toBe(0);
  });

  it('withdraws the draft fingerprint when findings change, so a stale draft cannot be signed', async () => {
    const inspectionId = await newInspection();
    const draft = await call('POST', `/inspections/${inspectionId}/render`);
    expect(draft.status).toBe(200);

    const saved = await call('PUT', `/inspections/${inspectionId}/findings`, {
      body: { findings: [{ room: 'Kitchen', item: 'Sink and taps', condition: 'damaged', note: 'Tap head snapped' }] },
    });
    expect(saved.status).toBe(200);

    const stale = await sign(inspectionId, 'landlord', draft.body.sha256);
    expect(stale.status).toBe(409);
    expect(stale.body.error.message).toMatch(/Render the report before signing/);

    const fresh = await call('POST', `/inspections/${inspectionId}/render`);
    expect(fresh.status).toBe(200);
    expect(fresh.body.sha256).not.toBe(draft.body.sha256);
    expect((await sign(inspectionId, 'landlord', fresh.body.sha256)).status).toBe(200);
  });

  it('seals only when both signatures attest the same draft, and retries a seal that failed', async () => {
    const inspectionId = await newInspection();
    const first = await call('POST', `/inspections/${inspectionId}/render`);
    expect((await sign(inspectionId, 'landlord', first.body.sha256)).status).toBe(200);

    // A re-render after the first signature can produce a new fingerprint (the creation
    // timestamp is in the file), which the first signature no longer attests. Simulate that
    // re-render directly so the case does not depend on crossing a second boundary.
    const moved = 'f'.repeat(64);
    await db.query('update inspection set draft_sha256 = $2 where id = $1', [inspectionId, moved]);

    const tenant = await sign(inspectionId, 'tenant', moved);
    expect(tenant.status).toBe(409);
    expect(tenant.body.error.message).toMatch(/changed after the first signature/);
    const afterConflict = await call('GET', `/inspections/${inspectionId}`);
    expect(afterConflict.body.signatures).toHaveLength(0);
    expect(afterConflict.body.status).toBe('awaiting_signatures');

    const second = await call('POST', `/inspections/${inspectionId}/render`);
    expect(second.status).toBe(200);

    expect((await sign(inspectionId, 'landlord', second.body.sha256)).status).toBe(200);
    const sealed = await sign(inspectionId, 'tenant', second.body.sha256);
    expect(sealed.status).toBe(200);
    expect(sealed.body.status).toBe('completed');

    const state = await call('GET', `/inspections/${inspectionId}`);
    expect(state.body.status).toBe('completed');
    expect(state.body.signatures).toHaveLength(2);
    expect(state.body.reportKey).toBeTruthy();
    const report = await storageLib.storage().get(state.body.reportKey);
    expect(Buffer.from(report.slice(0, 5)).toString()).toBe('%PDF-');

    // Both signatures on file but the seal never landed (a crash between the two): the next
    // POST from either party renders it instead of leaving a 'completed' inspection with no report.
    await db.query(
      `update inspection set status = 'awaiting_signatures', pdf_s3_key = null, pdf_sha256 = null, completed_at = null
        where id = $1`,
      [inspectionId],
    );
    const retried = await sign(inspectionId, 'landlord', second.body.sha256);
    expect(retried.status).toBe(200);
    expect(retried.body.status).toBe('completed');
    const again = await call('GET', `/inspections/${inspectionId}`);
    expect(again.body.status).toBe('completed');
    expect(again.body.reportKey).toBeTruthy();
    expect(again.body.signatures).toHaveLength(2);
  });

  it('closes a sealed inspection to further signatures and findings', async () => {
    const inspectionId = await newInspection();
    const draft = await call('POST', `/inspections/${inspectionId}/render`);
    await sign(inspectionId, 'landlord', draft.body.sha256);
    await sign(inspectionId, 'tenant', draft.body.sha256);
    expect((await sign(inspectionId, 'landlord', draft.body.sha256)).status).toBe(409);
    const edit = await call('PUT', `/inspections/${inspectionId}/findings`, {
      body: { findings: [{ room: 'Kitchen', item: 'Sink and taps', condition: 'good' }] },
    });
    expect(edit.status).toBe(409);
  });
});

describe('lease document', () => {
  it('cannot be re-rendered once anyone has signed it, and only by the landlord', async () => {
    const asTenantRender = await call('POST', `/leases/${LEASE}/render`, asTenant);
    expect(asTenantRender.status).toBe(403);

    const unsigned = await call('POST', `/leases/${LEASE}/render`);
    expect(unsigned.status).toBe(200);
    const before = await db.query<{ pdf_sha256: string }>('select pdf_sha256 from lease where id = $1', [LEASE]);

    await db.query(
      `insert into lease_signature (lease_id, party, signature_s3_key, pdf_sha256)
       values ($1, 'tenant', 'leases/x/signature-tenant.png', $2)`,
      [LEASE, before[0]!.pdf_sha256],
    );
    const signed = await call('POST', `/leases/${LEASE}/render`);
    expect(signed.status).toBe(409);
    expect(signed.body.error.message).toMatch(/has been signed/);
    const after = await db.query<{ pdf_sha256: string }>('select pdf_sha256 from lease where id = $1', [LEASE]);
    expect(after[0]!.pdf_sha256).toBe(before[0]!.pdf_sha256);
    await db.query('delete from lease_signature where lease_id = $1', [LEASE]);
  });
});

describe('deduction evidence', () => {
  let terminationId: string;
  let photoKey: string;

  beforeAll(async () => {
    const inspectionId = await newInspection();
    const presigned = await call('POST', `/inspections/${inspectionId}/photos/presign`, {
      body: { room: 'Kitchen', item: 'Sink and taps', contentType: 'image/jpeg', sizeBytes: 70 },
    });
    expect(presigned.status).toBe(201);
    photoKey = presigned.body.key;
    // The upload itself goes straight to storage; the bytes are a PNG whatever the label said.
    await storageLib.storage().put(photoKey, Buffer.from(ONE_PX, 'base64'), 'image/jpeg');
    const confirmed = await call('POST', '/photos/confirm', {
      body: { scope: 'inspection', photoId: presigned.body.photoId },
    });
    expect(confirmed.status).toBe(200);
    // The photo on file is the copy confirm kept, not the key the upload link points at.
    photoKey = confirmed.body.key;
    const [stored] = await db.query<{ content_type: string }>(
      'select content_type from inspection_photo where id = $1',
      [presigned.body.photoId],
    );
    expect(stored!.content_type).toBe('image/png');

    // Bytes that are no image at all are refused at confirm, so they never reach a report.
    const bogus = await call('POST', `/inspections/${inspectionId}/photos/presign`, {
      body: { room: 'Kitchen', item: 'Sink and taps', contentType: 'image/jpeg', sizeBytes: 20 },
    });
    await storageLib.storage().put(bogus.body.key, Buffer.from('<html>not a photo</html>'), 'image/jpeg');
    const refused = await call('POST', '/photos/confirm', {
      body: { scope: 'inspection', photoId: bogus.body.photoId },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toMatch(/not a JPEG or PNG/);

    const notice = await call('POST', `/leases/${LEASE}/termination`, {
      body: { initiatedBy: 'landlord', reason: 'end_of_term', noticeGivenOn: today() },
    });
    expect(notice.status).toBe(201);
    terminationId = notice.body.id;
  });

  it('refuses a key that is not a photo on this lease', async () => {
    for (const key of ['leases/x/signature-tenant.png', `inspections/other/${'a'.repeat(8)}.jpg`, '../.env']) {
      const refused = await call('POST', `/terminations/${terminationId}/deductions`, {
        body: { description: 'Cleaning', amountCents: 10000, evidenceS3Key: key },
      });
      expect(refused.status, key).toBe(400);
      expect(refused.body.error.message).toMatch(/photo on this lease/);
    }
  });

  it('accepts an uploaded photo on the lease and fixes the list once settled', async () => {
    const added = await call('POST', `/terminations/${terminationId}/deductions`, {
      body: { description: 'Cleaning', amountCents: 10000, evidenceS3Key: photoKey },
    });
    expect(added.status).toBe(201);

    await db.query("update termination set status = 'settled' where id = $1", [terminationId]);
    const removed = await call('DELETE', `/terminations/${terminationId}/deductions/${added.body.id}`);
    expect(removed.status).toBe(409);
    const stillThere = await db.query('select 1 from deposit_deduction where id = $1', [added.body.id]);
    expect(stillThere).toHaveLength(1);
    await db.query("update termination set status = 'reconciling' where id = $1", [terminationId]);
  });
});

describe('ticket listing', () => {
  it('shows a landlord only the tickets on their own properties', async () => {
    const created = await call('POST', `/leases/${LEASE}/tickets`, {
      ...asTenant,
      body: { category: 'plumbing', severity: 'urgent', title: 'Tap dripping', description: 'Kitchen tap has dripped since Monday morning.' },
    });
    expect(created.status).toBe(201);
    await db.query(
      `insert into landlord (trading_name, email, phone, cognito_sub)
       values ('Other Properties', 'other@example.co.za', '0820000000', 'sub-other-landlord')`,
    );

    const own = await call('GET', '/tickets');
    expect(own.body.items.some((item: { id: string }) => item.id === created.body.id)).toBe(true);
    const other = await call('GET', '/tickets', { sub: 'sub-other-landlord', groups: 'landlord' });
    expect(other.status).toBe(200);
    expect(other.body.items).toHaveLength(0);
  });
});
