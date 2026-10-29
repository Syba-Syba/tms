import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const LEASE = '66666666-6666-6666-6666-666666666666';

const ONE_PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const PNG = Buffer.from(ONE_PX, 'base64');
const SIGNATURE = `data:image/png;base64,${ONE_PX}`;
const PDF = Buffer.from('%PDF-1.4\n%fake but sniffable\n');

/**
 * Inspection signing that cannot loop, a disputed inspection that can be reopened, uploads
 * checked by their bytes before anyone relies on them, and an outbox claim that two
 * overlapping dispatch runs cannot both take.
 */
type Opts = { sub?: string; groups?: string; body?: unknown };
let call: (method: string, path: string, opts?: Opts) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let store: import('../lib/storage').Storage;

const asTenant: Opts = { sub: 'sub-tenant', groups: 'tenant' };
const today = () => new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://signing-uploads-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'tms-signing-uploads-'));
  process.env.KMS_DRIVER = 'local';

  db = await import('../lib/db');
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  for (const file of all.filter((n) => !n.includes('seed'))) await db.execScript(read(file));
  for (const file of all.filter((n) => n.includes('seed'))) await db.execScript(read(file));
  await db.query(
    `insert into landlord (trading_name, email, phone, cognito_sub)
     values ('Dlamini Rentals', 'two@example.co.za', '+27829999999', 'sub-landlord-two')`,
  );

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

afterEach(() => {
  vi.useRealTimers();
});

const moveClock = (seconds: number) => {
  const now = Date.now();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now + seconds * 1000);
};

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

const render = (inspectionId: string, opts: Opts = {}) => call('POST', `/inspections/${inspectionId}/render`, opts);

const sign = (inspectionId: string, party: 'landlord' | 'tenant', pdfSha256: string) =>
  call('POST', `/inspections/${inspectionId}/signature`, {
    ...(party === 'tenant' ? asTenant : {}),
    body: { party, signatureBase64: SIGNATURE, pdfSha256 },
  });

describe('inspection draft is deterministic', () => {
  it('renders the same bytes for an unchanged inspection, whenever it is rendered', async () => {
    const inspectionId = await newInspection();
    const first = await render(inspectionId);
    expect(first.status).toBe(200);
    moveClock(5);
    const second = await render(inspectionId, asTenant);
    expect(second.status).toBe(200);
    expect(second.body.sha256).toBe(first.body.sha256);
  });

  it('seals when the tenant re-renders after the landlord signed', async () => {
    const inspectionId = await newInspection();
    const draft = await render(inspectionId);
    expect((await sign(inspectionId, 'landlord', draft.body.sha256)).status).toBe(200);
    moveClock(5);
    const again = await render(inspectionId, asTenant);
    expect(again.status).toBe(200);
    const tenant = await sign(inspectionId, 'tenant', again.body.sha256);
    expect(tenant.status).toBe(200);
    expect(tenant.body.status).toBe('completed');
  });
});

describe('reopening a disputed inspection', () => {
  it('lets the tenant reopen it after the landlord signed, so a finding can be fixed', async () => {
    const inspectionId = await newInspection();
    const draft = await render(inspectionId);
    expect((await sign(inspectionId, 'landlord', draft.body.sha256)).status).toBe(200);

    // Locked while awaiting signatures.
    const locked = await call('PUT', `/inspections/${inspectionId}/findings`, {
      ...asTenant,
      body: { findings: [{ room: 'Kitchen', item: 'Sink and taps', condition: 'damaged', note: 'Already cracked' }] },
    });
    expect(locked.status).toBe(409);

    const reopened = await call('POST', `/inspections/${inspectionId}/reopen`, asTenant);
    expect(reopened.status).toBe(200);
    expect(reopened.body.status).toBe('in_progress');

    const [row] = await db.query<{ status: string; draft_sha256: string | null; draft_s3_key: string | null }>(
      'select status, draft_sha256, draft_s3_key from inspection where id = $1',
      [inspectionId],
    );
    expect(row).toEqual({ status: 'in_progress', draft_sha256: null, draft_s3_key: null });
    const signatures = await db.query('select 1 from inspection_signature where inspection_id = $1', [inspectionId]);
    expect(signatures).toHaveLength(0);
    const audited = await db.query<{ actor_role: string }>(
      `select actor_role from audit_log where action = 'inspection.reopened' and entity_id = $1`,
      [inspectionId],
    );
    expect(audited.map((a) => a.actor_role)).toEqual(['tenant']);

    const fixed = await call('PUT', `/inspections/${inspectionId}/findings`, {
      ...asTenant,
      body: { findings: [{ room: 'Kitchen', item: 'Sink and taps', condition: 'damaged', note: 'Already cracked' }] },
    });
    expect(fixed.status).toBe(200);

    const fresh = await render(inspectionId);
    expect((await sign(inspectionId, 'landlord', fresh.body.sha256)).status).toBe(200);
    expect((await sign(inspectionId, 'tenant', fresh.body.sha256)).body.status).toBe('completed');
  });

  it('refuses to reopen a sealed report', async () => {
    const inspectionId = await newInspection();
    const draft = await render(inspectionId);
    await sign(inspectionId, 'landlord', draft.body.sha256);
    await sign(inspectionId, 'tenant', draft.body.sha256);
    const refused = await call('POST', `/inspections/${inspectionId}/reopen`);
    expect(refused.status).toBe(409);
    const [row] = await db.query<{ status: string }>('select status from inspection where id = $1', [inspectionId]);
    expect(row!.status).toBe('completed');
  });

  it('is a no-op on an inspection still in progress, and closed to strangers', async () => {
    const inspectionId = await newInspection();
    expect((await call('POST', `/inspections/${inspectionId}/reopen`)).status).toBe(200);
    const stranger = await call('POST', `/inspections/${inspectionId}/reopen`, { sub: 'sub-landlord-two', groups: 'landlord' });
    expect([403, 404]).toContain(stranger.status);
  });
});

const newProof = async (contentType: string, sizeBytes: number) => {
  const created = await call('POST', `/leases/${LEASE}/payment-proofs`, {
    ...asTenant,
    body: { amountCents: 1000, paidOn: '2026-10-01', contentType, sizeBytes },
  });
  expect(created.status).toBe(201);
  const [row] = await db.query<{ s3_key: string }>('select s3_key from payment_proof where id = $1', [
    created.body.proofId,
  ]);
  return { id: created.body.proofId as string, key: row!.s3_key };
};

const proofRow = async (id: string) =>
  (await db.query<{ status: string; s3_key: string; content_type: string; size_bytes: string }>(
    'select status, s3_key, content_type, size_bytes::text from payment_proof where id = $1',
    [id],
  ))[0]!;

describe('payment proof submit checks the bytes', () => {
  it('refuses an upload bigger than 10 MB whatever was declared, and removes it', async () => {
    const proof = await newProof('image/png', 10);
    await store.put(proof.key, new Uint8Array(20 * 1024 * 1024), 'image/png');
    const submitted = await call('POST', `/payment-proofs/${proof.id}/submit`, asTenant);
    expect(submitted.status).toBe(400);
    expect(await store.sizeOf(proof.key)).toBeNull();
    expect((await proofRow(proof.id)).status).toBe('uploading');
  });

  it('refuses bytes that are not a JPEG, PNG or PDF', async () => {
    const proof = await newProof('image/png', 10);
    await store.put(proof.key, Buffer.from('<html>not a slip</html>'), 'image/png');
    const submitted = await call('POST', `/payment-proofs/${proof.id}/submit`, asTenant);
    expect(submitted.status).toBe(400);
    expect(await store.sizeOf(proof.key)).toBeNull();
  });

  it('keeps a copy the upload link cannot reach, typed by its bytes', async () => {
    const proof = await newProof('image/png', 10);
    await store.put(proof.key, PDF, 'image/png');
    const submitted = await call('POST', `/payment-proofs/${proof.id}/submit`, asTenant);
    expect(submitted.status).toBe(200);
    const row = await proofRow(proof.id);
    expect(row.status).toBe('pending');
    expect(row.s3_key).not.toBe(proof.key);
    expect(row.s3_key).toMatch(/\.kept\.pdf$/);
    expect(row.content_type).toBe('application/pdf');
    expect(Number(row.size_bytes)).toBe(PDF.length);

    // The link is still live; a second PUT lands on the old key only.
    await store.put(proof.key, Buffer.from('swapped'), 'image/png');
    expect(Buffer.from(await store.get(row.s3_key)).equals(PDF)).toBe(true);
  });
});

describe('expense slips are checked once uploaded', () => {
  const newExpense = async () => {
    const created = await call('POST', '/expenses', {
      body: {
        category: 'repairs', description: 'Geyser element', amountCents: 125000, incurredOn: '2026-10-01',
        slip: { contentType: 'image/jpeg', sizeBytes: 10 },
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.uploadUrl).toBeTruthy();
    const [row] = await db.query<{ slip_s3_key: string }>('select slip_s3_key from expense where id = $1', [
      created.body.id,
    ]);
    return { id: created.body.id as string, key: row!.slip_s3_key };
  };

  it('refuses a slip that is not an image or PDF, and detaches it', async () => {
    const expense = await newExpense();
    await store.put(expense.key, Buffer.from('MZ not a slip'), 'image/jpeg');
    const confirmed = await call('POST', `/expenses/${expense.id}/slip/confirm`);
    expect(confirmed.status).toBe(400);
    expect(await store.sizeOf(expense.key)).toBeNull();
    const [row] = await db.query<{ slip_s3_key: string | null }>('select slip_s3_key from expense where id = $1', [
      expense.id,
    ]);
    expect(row!.slip_s3_key).toBeNull();
  });

  it('refuses a slip over 10 MB', async () => {
    const expense = await newExpense();
    await store.put(expense.key, new Uint8Array(11 * 1024 * 1024), 'image/jpeg');
    expect((await call('POST', `/expenses/${expense.id}/slip/confirm`)).status).toBe(400);
    expect(await store.sizeOf(expense.key)).toBeNull();
  });

  it('keeps a checked copy of a good slip, and a retry leaves it alone', async () => {
    const expense = await newExpense();
    await store.put(expense.key, PNG, 'image/jpeg');
    const confirmed = await call('POST', `/expenses/${expense.id}/slip/confirm`);
    expect(confirmed.status).toBe(200);
    const [row] = await db.query<{ slip_s3_key: string }>('select slip_s3_key from expense where id = $1', [
      expense.id,
    ]);
    expect(row!.slip_s3_key).toMatch(/\.kept\.png$/);
    expect(Buffer.from(await store.get(row!.slip_s3_key)).equals(PNG)).toBe(true);
    expect((await call('POST', `/expenses/${expense.id}/slip/confirm`)).status).toBe(200);
    const [again] = await db.query<{ slip_s3_key: string }>('select slip_s3_key from expense where id = $1', [
      expense.id,
    ]);
    expect(again!.slip_s3_key).toBe(row!.slip_s3_key);
  });

  it('is closed to another landlord', async () => {
    const expense = await newExpense();
    await store.put(expense.key, PNG, 'image/jpeg');
    const other = await call('POST', `/expenses/${expense.id}/slip/confirm`, { sub: 'sub-landlord-two', groups: 'landlord' });
    expect(other.status).toBe(404);
  });
});

describe('notification dispatch claim', () => {
  it('leases claimed rows, so an overlapping run does not claim them again', async () => {
    const { claimBatch } = await import('../handlers/notifications-dispatch');
    await db.query('delete from notification');
    for (let n = 0; n < 3; n += 1) {
      await db.query(
        `insert into notification (lease_id, recipient_sub, recipient_to, channel, category, kind, urgent, subject, body)
         values ($1, 'sub-tenant', 'tenant@example.co.za', 'email', 'money', 'invoice_issued', false, 's', 'b')`,
        [LEASE],
      );
    }
    const first = await claimBatch();
    const second = await claimBatch();
    expect(first).toHaveLength(3);
    const firstIds = new Set(first.map((row) => row.id));
    expect(second.filter((row) => firstIds.has(row.id))).toEqual([]);
    const waiting = await db.query<{ waits: boolean }>('select send_after > now() as waits from notification');
    expect(waiting.every((row) => row.waits)).toBe(true);
  });
});
