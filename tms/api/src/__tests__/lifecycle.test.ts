import { beforeAll, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

/** One open application per unit, and the applicant hearing about the decision. */
type Opts = { sub?: string; groups?: string; email?: string; body?: unknown };
let call: (method: string, path: string, opts?: Opts) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://lifecycle-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'tms-storage-'));
  process.env.KMS_DRIVER = 'local';

  db = await import('../lib/db');
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
          jwt: {
            claims: {
              sub: opts.sub ?? 'sub-landlord',
              email: opts.email ?? '',
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

const applicant = { sub: 'sub-lifecycle', groups: 'tenant', email: 'Signed.In@Example.co.za' };

const apply = async (unitId: string) =>
  call('POST', '/applications', {
    ...applicant,
    body: {
      unitId,
      firstName: 'Thandi',
      lastName: 'Mokoena',
      idNumber: '9001015009086',
      email: 'typed-on-form@example.co.za',
      phone: '0825550001',
      employmentStatus: 'employed',
      monthlyIncomeCents: 4000000,
      occupants: 1,
      preferredMoveIn: '2099-01-01',
    },
  });

describe('applications', () => {
  let applicationId: string;

  it('refuses a second open application for the same unit', async () => {
    const units = await call('GET', '/units/available', applicant);
    const unitId = units.body.items[0].id as string;
    const first = await apply(unitId);
    expect(first.status).toBe(201);
    applicationId = first.body.id;
    const second = await apply(unitId);
    expect(second.status).toBe(409);
  });

  it('addresses the applicant at the signed-in email, not the one typed on the form', async () => {
    const [row] = await db.query<{ email: string }>(
      'select email from applicant where cognito_sub = $1',
      [applicant.sub],
    );
    expect(row!.email).toBe('signed.in@example.co.za');
  });

  it('tells the applicant the decision', async () => {
    const decided = await call('POST', `/applications/${applicationId}/decision`, {
      body: { outcome: 'declined', reason: 'Income below three times the rent.' },
    });
    expect(decided.status).toBe(200);
    const rows = await db.query<{ kind: string; body: string; recipient_to: string }>(
      `select kind, body, recipient_to from notification where recipient_sub = $1`,
      [applicant.sub],
    );
    const declined = rows.find((row) => row.kind === 'application_declined');
    expect(declined).toBeTruthy();
    expect(declined!.body).toContain('Income below three times the rent.');
    expect(declined!.recipient_to).toBe('signed.in@example.co.za');
  });
});
