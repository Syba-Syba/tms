import { beforeAll, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const LEASE = '66666666-6666-6666-6666-666666666666';

/** A renewal goes live, and is billed, only once both parties have signed it; and a landlord
    can record a tenant's written notice to cancel early. */
type Opts = { sub?: string; groups?: string; body?: unknown };
let call: (method: string, path: string, opts?: Opts) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let dates: typeof import('../domain/dates');

const tenant: Opts = { sub: 'sub-tenant', groups: 'tenant' };

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://renewal-signing-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'tms-storage-'));
  process.env.KMS_DRIVER = 'local';

  db = await import('../lib/db');
  dates = await import('../domain/dates');
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

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('a renewal is signed before it goes live', () => {
  let renewed: string;

  it('renders the new lease on acceptance, ready to sign', async () => {
    const offer = await call('POST', `/leases/${LEASE}/renewal`, { body: {} });
    expect(offer.status).toBe(201);
    const accepted = await call('POST', `/renewals/${offer.body.id}/decision`, {
      ...tenant,
      body: { decision: 'accept' },
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.documentReady).toBe(true);
    renewed = accepted.body.newLeaseId;

    const lease = await call('GET', `/leases/${renewed}`, tenant);
    expect(lease.body.status).toBe('scheduled');
    expect(lease.body.hasDocument).toBe(true);
    const old = await call('GET', `/leases/${LEASE}`);
    expect(old.body.renewedBy).toMatchObject({ id: renewed, signaturesOnFile: 0 });
  });

  it('neither activates nor bills an unsigned renewal, even once its start date passes', async () => {
    const month = dates.sastMonthStart();
    await db.query('update lease set start_date = $2 where id = $1', [renewed, month]);

    const { handler: activate } = await import('../handlers/leases-activate');
    expect((await activate()).activated).toBe(0);
    const { handler: bill } = await import('../handlers/invoices-run');
    await bill({ periods: [month] });
    const invoices = await db.query('select id from invoice where lease_id = $1', [renewed]);
    expect(invoices).toHaveLength(0);
    const [still] = await db.query<{ status: string }>('select status from lease where id = $1', [LEASE]);
    expect(still!.status).toBe('active');
  });

  it('goes live on the second signature when its start date has already passed', async () => {
    const lease = await call('GET', `/leases/${renewed}`);
    const sha = lease.body.pdfSha256 as string;
    const first = await call('POST', `/leases/${renewed}/signature`, {
      body: { party: 'landlord', signatureBase64: PNG, pdfSha256: sha },
    });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('scheduled');
    const second = await call('POST', `/leases/${renewed}/signature`, {
      ...tenant,
      body: { party: 'tenant', signatureBase64: PNG, pdfSha256: sha },
    });
    expect(second.status).toBe(200);
    expect(second.body.status).toBe('active');

    const rows = await db.query<{ id: string; status: string }>(
      'select id, status from lease where id = any($1::uuid[])',
      [[LEASE, renewed]],
    );
    expect(Object.fromEntries(rows.map((row) => [row.id, row.status]))).toEqual({
      [LEASE]: 'terminated',
      [renewed]: 'active',
    });
  });

  describe('early cancellation recorded by the landlord', () => {
    it('records the tenant’s written notice, dated when it arrived, with a penalty', async () => {
      const givenOn = dates.addDaysIso(dates.sastToday(), -5);
      const response = await call('POST', `/leases/${renewed}/termination`, {
        body: { initiatedBy: 'tenant', reason: 'early_tenant', noticeGivenOn: givenOn, penaltyCents: 50000 },
      });
      expect(response.status).toBe(201);
      const [row] = await db.query<{ initiated_by: string; notice_given_on: string; penalty_cents: string }>(
        'select initiated_by, notice_given_on::text, penalty_cents::text from termination where lease_id = $1',
        [renewed],
      );
      expect(row).toEqual({ initiated_by: 'tenant', notice_given_on: givenOn, penalty_cents: '50000' });
    });
  });

  it('the morning job activates a signed renewal on its start date, not before', async () => {
    const [current] = await db.query<{ application_id: string; unit_id: string; applicant_id: string }>(
      'select application_id, unit_id, applicant_id from lease where id = $1',
      [renewed],
    );
    const [next] = await db.query<{ id: string }>(
      `insert into lease (application_id, unit_id, applicant_id, start_date, end_date,
                          monthly_rent_cents, escalation_pct, deposit_cents, status, previous_lease_id)
       values ($1, $2, $3, $4, $5, 900000, 8, 900000, 'scheduled', $6) returning id`,
      [
        current!.application_id, current!.unit_id, current!.applicant_id,
        dates.addDaysIso(dates.sastToday(), 10), dates.addDaysIso(dates.sastToday(), 375), renewed,
      ],
    );
    for (const party of ['landlord', 'tenant']) {
      await db.query(
        `insert into lease_signature (lease_id, party, signature_s3_key, pdf_sha256)
         values ($1, $2, 'test/signature.png', 'sha')`,
        [next!.id, party],
      );
    }
    const { handler: activate } = await import('../handlers/leases-activate');
    expect((await activate()).activated).toBe(0);
    await db.query('update lease set start_date = $2 where id = $1', [next!.id, dates.sastToday()]);
    expect((await activate()).activated).toBe(1);
    const [row] = await db.query<{ status: string }>('select status from lease where id = $1', [next!.id]);
    expect(row!.status).toBe('active');
  });
});
