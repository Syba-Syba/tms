import { beforeAll, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '../../../db/migrations');
const UNIT_A2 = '33333333-3333-3333-3333-333333333334';
const UNIT_B1 = '33333333-3333-3333-3333-333333333335';

type Opts = { sub?: string; groups?: string; body?: unknown };
let call: (method: string, path: string, opts?: Opts) => Promise<{ status: number; body: any }>;
let storageLib: typeof import('../lib/storage');
let db: typeof import('../lib/db');

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://review-sas-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'tms-storage-'));
  process.env.KMS_DRIVER = 'local';

  db = await import('../lib/db');
  storageLib = await import('../lib/storage');
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  for (const file of all.filter((n) => !n.includes('seed'))) await db.execScript(read(file));
  for (const file of all.filter((n) => n.includes('seed'))) await db.execScript(read(file));

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

const apply = (sub: string, unitId: string) =>
  call('POST', '/applications', {
    sub,
    groups: 'tenant',
    body: {
      unitId,
      firstName: 'Sipho',
      lastName: 'Ndlovu',
      idNumber: '9001015009086',
      email: `${sub}@example.co.za`,
      phone: '0825550002',
      employmentStatus: 'employed',
      monthlyIncomeCents: 4000000,
      occupants: 1,
      preferredMoveIn: '2099-01-01',
    },
  });

/** server.ts exits unless it is the self-hosted server, so its clientAddress is read from source. */
const loadClientAddress = (trustProxy: boolean) => {
  const source = readFileSync(join(HERE, '../server.ts'), 'utf8');
  const start = source.indexOf('function clientAddress(');
  const end = source.indexOf('\n}\n', start) + 2;
  const { code } = transformSync(source.slice(start, end), { loader: 'ts' });
  return new Function('TRUST_PROXY', `${code}; return clientAddress;`)(trustProxy) as (request: unknown) => string;
};

describe('the address behind a proxy', () => {
  const request = (forwarded?: string) => ({
    headers: forwarded ? { 'x-forwarded-for': forwarded } : {},
    socket: { remoteAddress: '10.0.0.1' },
  });

  it('takes the entry our proxy appended, not one the client wrote', () => {
    const clientAddress = loadClientAddress(true);
    expect(clientAddress(request('6.6.6.6, 203.0.113.9'))).toBe('203.0.113.9');
    expect(clientAddress(request('203.0.113.9'))).toBe('203.0.113.9');
    expect(clientAddress(request('6.6.6.6, 203.0.113.9, '))).toBe('203.0.113.9');
    expect(clientAddress(request())).toBe('10.0.0.1');
  });

  it('ignores the header without TRUST_PROXY', () => {
    expect(loadClientAddress(false)(request('6.6.6.6'))).toBe('10.0.0.1');
  });
});

describe('applying again for a unit', () => {
  let approvedId: string;

  it('refuses a second application once the first is approved', async () => {
    const first = await apply('sub-reapply', UNIT_A2);
    expect(first.status).toBe(201);
    const approved = await call('POST', `/applications/${first.body.id}/decision`, {
      body: { outcome: 'approved' },
    });
    expect(approved.status).toBe(200);
    approvedId = first.body.id;
    expect((await apply('sub-reapply', UNIT_A2)).status).toBe(409);
  });

  it('refuses anyone once the unit has a lease out for signature', async () => {
    const lease = await call('POST', `/applications/${approvedId}/lease`, {
      body: { startDate: '2099-01-01', months: 12, escalationPct: 8 },
    });
    expect(lease.status).toBe(201);
    expect((await apply('sub-someone-else', UNIT_A2)).status).toBe(409);
  });
});

describe('application documents', () => {
  let applicationId: string;
  const owner: Opts = { sub: 'sub-docs', groups: 'tenant' };
  const PDF = new Uint8Array(Buffer.from('%PDF-1.4\n%%EOF\n', 'latin1'));

  const presign = async () => {
    const response = await call('POST', `/applications/${applicationId}/documents/presign`, {
      ...owner,
      body: { kind: 'payslip', contentType: 'application/pdf', sizeBytes: PDF.length },
    });
    expect(response.status).toBe(201);
    return response.body.key as string;
  };
  const confirm = (key: string) =>
    call('POST', `/applications/${applicationId}/documents/confirm`, { ...owner, body: { key } });
  const onFile = async () =>
    (await call('GET', `/applications/${applicationId}/documents`)).body.items as { kind: string; key?: string }[];

  it('counts nothing until an upload has landed and been confirmed', async () => {
    const created = await apply('sub-docs', UNIT_B1);
    expect(created.status).toBe(201);
    applicationId = created.body.id;

    const failed = await presign();
    await presign();
    expect(await onFile()).toHaveLength(0);
    // A PUT that never arrived cannot be confirmed into a document.
    expect((await confirm(failed)).status).toBe(400);
    expect(await onFile()).toHaveLength(0);

    const landed = await presign();
    await storageLib.storage().put(landed, PDF, 'application/pdf');
    expect((await confirm(landed)).status).toBe(200);
    expect((await confirm(landed)).status).toBe(200);
    expect(await onFile()).toHaveLength(1);
  });

  it('replaces the earlier document of the same kind', async () => {
    const replacement = await presign();
    await storageLib.storage().put(replacement, PDF, 'application/pdf');
    expect((await confirm(replacement)).status).toBe(200);
    expect(await onFile()).toHaveLength(1);
    const rows = await db.query<{ s3_key: string }>(
      'select s3_key from application_document where application_id = $1',
      [applicationId],
    );
    expect(rows.map((row) => row.s3_key)).toEqual([replacement]);
  });

  it('refuses bytes that are not a document, and a key from another application', async () => {
    const junk = await presign();
    await storageLib.storage().put(junk, new Uint8Array([1, 2, 3, 4, 5, 6]), 'application/pdf');
    expect((await confirm(junk)).status).toBe(400);

    const foreign = `applications/${UNIT_A2}/payslip/${crypto.randomUUID()}.pdf`;
    expect((await confirm(foreign)).status).toBe(400);
    expect(await onFile()).toHaveLength(1);
  });
});
