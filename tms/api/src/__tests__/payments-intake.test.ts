import { beforeAll, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

/**
 * Money coming in without the landlord typing it: a tenant's slip, and the bank statement.
 * Driven through the real router against a real Postgres, with a second landlord present so
 * every route is also checked for reaching across landlords.
 */
type As = { sub: string; groups: string };
const LANDLORD: As = { sub: 'sub-landlord', groups: 'landlord' };
const OTHER: As = { sub: 'sub-landlord-two', groups: 'landlord' };
const TENANT: As = { sub: 'sub-tenant', groups: 'tenant' };
const LEASE = '66666666-6666-6666-6666-666666666666';

let call: (method: string, path: string, as: As, body?: unknown) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let storage: typeof import('../lib/storage');

const invoice = async (period: string, cents = 850000) => {
  const [row] = await db.query<{ id: string }>(
    `insert into invoice (lease_id, period_start, due_on, total_cents)
     values ($1, $2, $2::date + 6, $3) returning id`,
    [LEASE, period, cents],
  );
  await db.query(
    `insert into invoice_line (invoice_id, kind, description, amount_cents) values ($1, 'rent', 'Rent', $2)`,
    [row!.id, cents],
  );
  return row!.id;
};

/** Create, upload, submit: the three steps the tenant's phone makes. */
const sendSlip = async (body: Record<string, unknown>) => {
  const created = await call('POST', `/leases/${LEASE}/payment-proofs`, TENANT, {
    contentType: 'application/pdf',
    sizeBytes: 1200,
    paidOn: '2026-10-01',
    ...body,
  });
  expect(created.status).toBe(201);
  const [proof] = await db.query<{ s3_key: string }>('select s3_key from payment_proof where id = $1', [
    created.body.proofId,
  ]);
  await storage.storage().put(proof!.s3_key, new Uint8Array([37, 80, 68, 70]), 'application/pdf');
  const submitted = await call('POST', `/payment-proofs/${created.body.proofId}/submit`, TENANT);
  expect(submitted.status).toBe(200);
  return created.body.proofId as string;
};

const paidOn = async (invoiceId: string) => {
  const [row] = await db.query<{ status: string; paid: string }>(
    `select i.status, coalesce(sum(p.amount_cents), 0)::text as paid
       from invoice i left join payment p on p.invoice_id = i.id
      where i.id = $1 group by i.status`,
    [invoiceId],
  );
  return { status: row!.status, paid: Number(row!.paid) };
};

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://payments-intake-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'tms-intake-'));
  process.env.KMS_DRIVER = 'local';

  db = await import('../lib/db');
  storage = await import('../lib/storage');
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  for (const file of all.filter((n) => !n.includes('seed'))) await db.execScript(read(file));
  for (const file of all.filter((n) => n.includes('seed'))) await db.execScript(read(file));
  await db.query(
    `insert into landlord (trading_name, email, phone, cognito_sub)
     values ('Dlamini Rentals', 'two@example.co.za', '+27829999999', $1)`,
    [OTHER.sub],
  );

  const { handler } = await import('../api');
  call = async (method, path, as, body) => {
    const [rawPath, rawQuery] = path.split('?');
    const event = {
      rawPath,
      headers: { 'content-type': 'application/json' },
      queryStringParameters: Object.fromEntries(new URLSearchParams(rawQuery ?? '')),
      pathParameters: {},
      body: body ? JSON.stringify(body) : undefined,
      requestContext: {
        http: { method, path: rawPath, sourceIp: '127.0.0.1', userAgent: 'test' },
        authorizer: { jwt: { claims: { sub: as.sub, 'cognito:groups': `[${as.groups}]` } } },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
    const result = (await handler(event)) as { statusCode: number; body?: string };
    return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : null };
  };
}, 120_000);

describe('proof of payment', () => {
  let august: string;
  let september: string;

  it('shows the tenant their real EFT reference', async () => {
    const statement = await call('GET', `/leases/${LEASE}/statement`, TENANT);
    expect(statement.body.reference).toBe('LSE-00101');
  });

  it('only lets the tenant send a slip, and refuses a future date', async () => {
    const asLandlord = await call('POST', `/leases/${LEASE}/payment-proofs`, LANDLORD, {
      amountCents: 100, paidOn: '2026-10-01', contentType: 'application/pdf', sizeBytes: 10,
    });
    expect(asLandlord.status).toBe(403);
    const future = await call('POST', `/leases/${LEASE}/payment-proofs`, TENANT, {
      amountCents: 100, paidOn: '2999-01-01', contentType: 'application/pdf', sizeBytes: 10,
    });
    expect(future.status).toBe(400);
  });

  it('will not submit a slip whose file never arrived', async () => {
    const created = await call('POST', `/leases/${LEASE}/payment-proofs`, TENANT, {
      amountCents: 100, paidOn: '2026-10-01', contentType: 'application/pdf', sizeBytes: 10,
    });
    const submitted = await call('POST', `/payment-proofs/${created.body.proofId}/submit`, TENANT);
    expect(submitted.status).toBe(400);
  });

  it('queues a submitted slip for the landlord, and tells them', async () => {
    august = await invoice('2026-08-01');
    september = await invoice('2026-09-01');
    const proofId = await sendSlip({ amountCents: 850000, reference: 'LSE-00101' });

    const queue = await call('GET', '/payment-proofs', LANDLORD);
    expect(queue.body.items.map((item: { id: string }) => item.id)).toContain(proofId);
    expect(queue.body.items[0].owedCents).toBe(1700000);

    const notified = await db.query(
      `select 1 from notification where kind = 'proof_submitted' and recipient_sub = 'sub-landlord'`,
    );
    expect(notified.length).toBeGreaterThan(0);

    const tenantView = await call('GET', `/leases/${LEASE}/statement`, TENANT);
    expect(tenantView.body.proofs[0]).toMatchObject({ id: proofId, status: 'pending' });
  });

  it('keeps the slip and its file away from another landlord', async () => {
    const queue = await call('GET', '/payment-proofs', OTHER);
    expect(queue.body.items).toHaveLength(0);
    const [proof] = await db.query<{ id: string; s3_key: string }>(
      `select id, s3_key from payment_proof where status = 'pending' limit 1`,
    );
    expect((await call('POST', `/payment-proofs/${proof!.id}/decision`, OTHER, { decision: 'accept' })).status).toBe(403);
    expect((await call('POST', '/files/view', OTHER, { key: proof!.s3_key })).status).toBe(404);
    expect((await call('POST', '/files/view', LANDLORD, { key: proof!.s3_key })).status).toBe(200);
  });

  it('needs a reason to reject, and tells the tenant what it was', async () => {
    const [proof] = await db.query<{ id: string }>(`select id from payment_proof where status = 'pending' limit 1`);
    expect((await call('POST', `/payment-proofs/${proof!.id}/decision`, LANDLORD, { decision: 'reject', reason: '' })).status).toBe(400);
    const rejected = await call('POST', `/payment-proofs/${proof!.id}/decision`, LANDLORD, {
      decision: 'reject', reason: 'Nothing arrived in the account.',
    });
    expect(rejected.status).toBe(200);
    const [message] = await db.query<{ body: string }>(
      `select body from notification where kind = 'proof_rejected' and recipient_sub = 'sub-tenant'`,
    );
    expect(message!.body).toContain('Nothing arrived in the account.');
    expect((await call('POST', `/payment-proofs/${proof!.id}/decision`, LANDLORD, { decision: 'accept' })).status).toBe(409);
  });

  it('spreads one slip for two months over both invoices, oldest first', async () => {
    const proofId = await sendSlip({ amountCents: 1700000 });
    const accepted = await call('POST', `/payment-proofs/${proofId}/decision`, LANDLORD, { decision: 'accept' });
    expect(accepted.status).toBe(200);
    expect(await paidOn(august)).toEqual({ status: 'paid', paid: 850000 });
    expect(await paidOn(september)).toEqual({ status: 'paid', paid: 850000 });
    const linked = await db.query('select 1 from payment where proof_id = $1', [proofId]);
    expect(linked).toHaveLength(2);
  });

  it('refuses to accept more than the lease owes, and leaves the slip waiting', async () => {
    const proofId = await sendSlip({ amountCents: 5000 });
    const accepted = await call('POST', `/payment-proofs/${proofId}/decision`, LANDLORD, { decision: 'accept' });
    expect(accepted.status).toBe(409);
    expect(accepted.body.error.message).toMatch(/Nothing is owed/);
    const [row] = await db.query<{ status: string }>('select status from payment_proof where id = $1', [proofId]);
    expect(row!.status).toBe('pending');
    await call('POST', `/payment-proofs/${proofId}/decision`, LANDLORD, { decision: 'reject', reason: 'Sent by mistake.' });
  });
});

describe('bank statement import', () => {
  const statement = [
    'Date,Amount,Balance,Description',
    '2026/10/01,8500.00,33500.00,"FNB APP PAYMENT FROM N PHIRI LSE-00101"',
    '2026/10/02,-450.00,33050.00,"POS PURCHASE BUILDERS"',
    '2026/10/03,123.45,33173.45,"INTEREST"',
  ].join('\n');
  let importId: string;
  let october: string;

  it('is for landlords only', async () => {
    expect((await call('POST', '/bank-imports', TENANT, { fileName: 's.csv', content: statement })).status).toBe(403);
  });

  it('explains a file it cannot read', async () => {
    const bad = await call('POST', '/bank-imports', LANDLORD, { fileName: 's.csv', content: 'nothing,here\n' });
    expect(bad.status).toBe(400);
  });

  it('keeps the credits and suggests the lease from the reference and a pending slip', async () => {
    october = await invoice('2026-10-01');
    await sendSlip({ amountCents: 850000 });
    const imported = await call('POST', '/bank-imports', LANDLORD, { fileName: 'fnb.csv', content: statement });
    expect(imported.status).toBe(201);
    expect(imported.body.summary).toEqual({ credits: 2, added: 2, alreadyImported: 0, debitsSkipped: 1 });
    importId = imported.body.id;
    const [rent, interest] = imported.body.lines;
    expect(rent.suggestion).toMatchObject({ leaseId: LEASE, confidence: 'high' });
    expect(interest.suggestion).toBeNull();
  });

  it('records the confirmed line once, settles the invoice and accepts the slip', async () => {
    const detail = await call('GET', `/bank-imports/${importId}`, LANDLORD);
    const [rent, interest] = detail.body.lines;
    const resolved = await call('POST', `/bank-imports/${importId}/resolve`, LANDLORD, {
      lines: [{ lineId: rent.id, leaseId: LEASE }, { lineId: interest.id, ignore: true }],
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body.results.every((result: { ok: boolean }) => result.ok)).toBe(true);
    expect(await paidOn(october)).toEqual({ status: 'paid', paid: 850000 });

    const [payment] = await db.query<{ bank_line_id: string; proof_id: string | null }>(
      'select bank_line_id, proof_id from payment where invoice_id = $1',
      [october],
    );
    expect(payment!.bank_line_id).toBe(rent.id);
    expect(payment!.proof_id).not.toBeNull();
    const pending = await db.query(`select 1 from payment_proof where status = 'pending'`);
    expect(pending).toHaveLength(0);

    const again = await call('POST', `/bank-imports/${importId}/resolve`, LANDLORD, {
      lines: [{ lineId: rent.id, leaseId: LEASE }],
    });
    expect(again.body.results[0]).toMatchObject({ ok: false });
  });

  it('skips lines already imported from an overlapping statement', async () => {
    const repeat = await call('POST', '/bank-imports', LANDLORD, { fileName: 'fnb-again.csv', content: statement });
    expect(repeat.body.summary).toMatchObject({ added: 0, alreadyImported: 2 });
    const list = await call('GET', '/bank-imports', LANDLORD);
    expect(list.body.items).toHaveLength(2);
  });

  it('hides one landlord\'s import from another', async () => {
    expect((await call('GET', `/bank-imports/${importId}`, OTHER)).status).toBe(404);
    expect((await call('GET', '/bank-imports', OTHER)).body.items).toHaveLength(0);
    const detail = await call('GET', `/bank-imports/${importId}`, LANDLORD);
    const tried = await call('POST', `/bank-imports/${importId}/resolve`, OTHER, {
      lines: [{ lineId: detail.body.lines[0].id, ignore: true }],
    });
    expect(tried.status).toBe(404);
  });
});

describe('a slip for a month paid another way meanwhile', () => {
  it('goes to the oldest open month instead of failing', async () => {
    const november = await invoice('2026-11-01');
    const december = await invoice('2026-12-01');
    const proofId = await sendSlip({ amountCents: 850000, invoiceId: november });
    await db.query(
      `insert into payment (lease_id, invoice_id, amount_cents, method, received_on, recorded_by)
       values ($1, $2, 850000, 'cash', '2026-11-02', 'sub-landlord')`,
      [LEASE, november],
    );
    await db.query(`update invoice set status = 'paid' where id = $1`, [november]);
    const accepted = await call('POST', `/payment-proofs/${proofId}/decision`, LANDLORD, { decision: 'accept' });
    expect(accepted.status).toBe(200);
    expect(await paidOn(december)).toEqual({ status: 'paid', paid: 850000 });
  });
});

describe('a slip accepted before the bank statement arrives', () => {
  it('links the bank line to the payment already recorded instead of counting the money twice', async () => {
    const june = await invoice('2026-06-01');
    const july = await invoice('2026-07-01');
    const proofId = await sendSlip({ amountCents: 850000, invoiceId: june, paidOn: '2026-06-02' });
    expect((await call('POST', `/payment-proofs/${proofId}/decision`, LANDLORD, { decision: 'accept' })).status).toBe(200);

    const statement = ['Date,Amount,Balance,Description', '2026/06/03,8500.00,42000.00,"FNB APP PAYMENT FROM N PHIRI LSE-00101"'].join('\n');
    const imported = await call('POST', '/bank-imports', LANDLORD, { fileName: 'jul.csv', content: statement });
    const [line] = imported.body.lines;
    const resolved = await call('POST', `/bank-imports/${imported.body.id}/resolve`, LANDLORD, { lines: [{ lineId: line.id, leaseId: LEASE }] });
    expect(resolved.body.results[0]).toMatchObject({ ok: true });

    // One payment of R8 500, now tied to both the slip and the bank line. Before, the line was
    // recorded again and the second R8 500 landed on July.
    const payments = await db.query<{ proof_id: string | null; bank_line_id: string | null }>(
      'select proof_id, bank_line_id from payment where lease_id = $1 and (proof_id = $2 or bank_line_id = $3)',
      [LEASE, proofId, line.id],
    );
    expect(payments).toEqual([{ proof_id: proofId, bank_line_id: line.id }]);
    expect(await paidOn(july)).toEqual({ status: 'issued', paid: 0 });
  });
});
