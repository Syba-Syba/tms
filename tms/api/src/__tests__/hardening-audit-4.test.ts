import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { parse } from 'yaml';
import { codeFor, stepAt } from '../lib/totp';

/** Audit round 4, hardening batch: findings 19, 20, 31-40, 66-71 and 73. */

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '../../../db/migrations');
const API_ROOT = join(HERE, '../..');
const DEPLOY = join(HERE, '../../../../deploy');
const LEASE = '66666666-6666-6666-6666-666666666666';

type As = { sub: string; groups: string };
const OWNER: As = { sub: 'sub-landlord', groups: 'landlord' };
const TENANT: As = { sub: 'sub-tenant', groups: 'tenant' };
const NOBODY: As = { sub: 'anonymous', groups: 'tenant' };
let call: (method: string, path: string, as: As, body?: unknown) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let storage: typeof import('../lib/storage');

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://hardening4-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.AUTH_DRIVER = 'local';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'tms-hardening4-'));
  process.env.KMS_DRIVER = 'local';
  db = await import('../lib/db');
  storage = await import('../lib/storage');
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  for (const file of all.filter((n) => !n.includes('seed'))) await db.execScript(read(file));
  for (const file of all.filter((n) => n.includes('seed'))) await db.execScript(read(file));
  const { handler } = await import('../api');
  let ip = 0;
  call = async (method, fullPath, as, body) => {
    const [path = fullPath, search] = fullPath.split('?');
    const event = {
      rawPath: path,
      headers: { 'content-type': 'application/json' },
      queryStringParameters: Object.fromEntries(new URLSearchParams(search ?? '')),
      pathParameters: {},
      body: body === undefined ? undefined : JSON.stringify(body),
      requestContext: {
        http: { method, path, sourceIp: `10.44.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`, userAgent: 'test' },
        authorizer: { jwt: { claims: { sub: as.sub, 'cognito:groups': `[${as.groups}]` } } },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
    const result = (await handler(event)) as { statusCode: number; body?: string };
    return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : null };
  };
}, 120_000);

afterAll(() => vi.useRealTimers());

const PDF = new TextEncoder().encode('%PDF-1.4\n%drill\n');

describe('19: a bank change needs two-step that has been on a while', () => {
  it('refuses while two-step is new, and allows it once two days have passed', async () => {
    const bank = (accountNumber: string) => ({ bank: { name: 'Capitec', holder: 'Mokoena Properties', accountNumber, branchCode: '470010' } });
    // An account is on file first, so the next one is a replacement.
    await db.query(`update landlord set bank_account_number = '1111222233', bank_branch_code = '470010' where cognito_sub = 'sub-landlord'`);
    let clock = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(clock);
    const code = () => {
      clock += 31_000;
      vi.setSystemTime(clock);
      return codeFor(secret, stepAt(clock));
    };
    const setup = await call('POST', '/auth/two-step', OWNER, { action: 'setup', password: 'dev' });
    const secret = setup.body.secret as string;
    expect((await call('POST', '/auth/two-step', OWNER, { action: 'enable', password: 'dev', code: code() })).status).toBe(200);

    // What someone holding only the password could do: turn it on with their own app, then redirect the rent.
    const tooSoon = await call('PUT', '/landlord', OWNER, { ...bank('9999888877'), code: code() });
    expect([tooSoon.status, tooSoon.body.error.code]).toEqual([403, 'two_step_too_new']);
    const [still] = await db.query<{ n: string }>(`select bank_account_number as n from landlord where cognito_sub = 'sub-landlord'`);
    expect(still!.n).toBe('1111222233');

    await db.query(`update local_credential set totp_enabled_at = now() - interval '3 days' where sub = 'sub-landlord'`);
    expect((await call('PUT', '/landlord', OWNER, { ...bank('9999888877'), code: code() })).status).toBe(200);

    // Off and on again restarts the wait.
    expect((await call('POST', '/auth/two-step', OWNER, { action: 'disable', password: 'dev', code: code() })).status).toBe(200);
    const again = await call('POST', '/auth/two-step', OWNER, { action: 'setup', password: 'dev' });
    const fresh = again.body.secret as string;
    clock += 31_000;
    vi.setSystemTime(clock);
    expect((await call('POST', '/auth/two-step', OWNER, { action: 'enable', password: 'dev', code: codeFor(fresh, stepAt(clock)) })).status).toBe(200);
    clock += 31_000;
    vi.setSystemTime(clock);
    const reEnabled = await call('PUT', '/landlord', OWNER, { ...bank('5555444433'), code: codeFor(fresh, stepAt(clock)) });
    expect(reEnabled.body.error.code).toBe('two_step_too_new');

    // Leave the seeded owner as the other tests expect: two-step off.
    await db.query(`update local_credential set totp_enabled_at = null, totp_secret_enc = null where sub = 'sub-landlord'`);
    vi.useRealTimers();
  });
});

describe('20: a password reset does not sign in a removed agent', () => {
  it('changes the password but hands out no session', async () => {
    await db.query(
      `insert into local_credential (sub, email, name, role, password_hash)
       values ('sub-removed-agent', 'gone.agent@example.co.za', 'Gone Agent', 'landlord', 'plain:old-password')`,
    );
    await call('POST', '/auth/reset/request', NOBODY, { email: 'gone.agent@example.co.za' });
    const [row] = await db.query<{ body: string }>(
      `select body from notification where kind = 'password_reset' and recipient_sub = 'sub-removed-agent' order by created_at desc limit 1`,
    );
    const token = row!.body.match(/token=([A-Za-z0-9_-]+)/)![1];
    const reset = await call('POST', '/auth/reset/confirm', NOBODY, { token, newPassword: 'a-new-long-password' });
    expect(reset.status).toBe(403);
    expect(reset.body.token).toBeUndefined();
    const [credential] = await db.query<{ password_hash: string }>(`select password_hash from local_credential where sub = 'sub-removed-agent'`);
    expect(credential!.password_hash).not.toBe('plain:old-password');
  });
});

describe('31: the bank statement parser is bounded', () => {
  it('refuses a header-less file with a very wide row, quickly', async () => {
    const { parseStatement, StatementError } = await import('../domain/bank-statement');
    const text = [`1/1/2026${','.repeat(200_000)}`, ...Array.from({ length: 10_000 }, () => '1/1/2026,x')].join('\n');
    const started = Date.now();
    expect(() => parseStatement('statement.csv', text)).toThrow(StatementError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('still reads a header-less statement of many rows', async () => {
    const { parseStatement } = await import('../domain/bank-statement');
    const rows = Array.from({ length: 3_000 }, (_, i) => `2026/01/${String((i % 28) + 1).padStart(2, '0')},${(i % 900) + 100}.00,Rent ref ${i}`);
    const parsed = parseStatement('statement.csv', rows.join('\n'));
    expect(parsed.lines).toHaveLength(3_000);
  });

  it('reads a spreadsheet export whose rows are padded with empty cells', async () => {
    const { parseStatement } = await import('../domain/bank-statement');
    const pad = ','.repeat(120);
    const text = [`Date,Amount,Description${pad}`, `2026/01/05,1500.00,Rent ref 1${pad}`, `2026/01/06,900.00,Rent ref 2${pad}`].join('\n');
    expect(parseStatement('statement.csv', text).lines).toHaveLength(2);
  });
});

describe('32: an upload link cannot overwrite what was already uploaded (self-hosted)', () => {
  it('writes each signed PUT once, and lets the same bytes be sent again', async () => {
    const { spawn } = await import('node:child_process');
    const { createHmac, randomBytes } = await import('node:crypto');
    const secret = randomBytes(32).toString('hex');
    const port = 39_000 + Math.floor(Math.random() * 900);
    const child = spawn(join(API_ROOT, '../../node_modules/.bin/tsx'), ['src/server.ts'], {
      cwd: API_ROOT,
      env: {
        ...process.env, NODE_ENV: 'production', APP_MODE: 'self-hosted', AUTH_DRIVER: 'local', STORAGE_DRIVER: 'local',
        STORAGE_DIR: mkdtempSync(join(tmpdir(), 'tms-files32-')), AUTH_SECRET: randomBytes(32).toString('hex'),
        STORAGE_SECRET: secret, RUN_JOBS: 'false', PORT: String(port), DB_DRIVER: 'pglite',
        DB_HOST: 'x', DB_NAME: 'x', DB_SECRET_ARN: 'x', DOCS_BUCKET: 'x', KMS_KEY_ID: 'x',
      },
      stdio: 'ignore',
    });
    try {
      const key = 'expenses/l/slip.jpg';
      const expires = Math.floor(Date.now() / 1000) + 300;
      const sig = createHmac('sha256', secret).update(`PUT\n${key}\n${expires}`).digest('hex');
      const url = `http://127.0.0.1:${port}/files/${key}?exp=${expires}&sig=${sig}`;
      const put = (body: string) => fetch(url, { method: 'PUT', body }).then((r) => r.status);
      for (let i = 0; i < 60; i += 1) {
        const up = await fetch(`http://127.0.0.1:${port}/files/x`).then((r) => r.status).catch(() => 0);
        if (up !== 0) break;
        await new Promise((done) => setTimeout(done, 250));
      }
      expect(await put('checked bytes')).toBe(204);
      // A retry after a lost answer carries the same bytes and succeeds.
      expect(await put('checked bytes')).toBe(204);
      expect(await put('swapped bytes')).toBe(409);
    } finally {
      child.kill();
    }
  }, 30_000);
});

describe('33: an inspection draft does not outlive the next one', () => {
  let inspectionId: string;
  const draftKey = async () =>
    (await db.query<{ key: string | null }>('select draft_s3_key as key from inspection where id = $1', [inspectionId]))[0]!.key;

  it('removes the previous draft on a re-render, and the draft when findings change', async () => {
    await db.query(`delete from deposit_deduction where finding_id in
      (select f.id from inspection_finding f join inspection i on i.id = f.inspection_id where i.lease_id = $1)`, [LEASE]);
    await db.query(`delete from inspection where lease_id = $1 and kind = 'incoming'`, [LEASE]);
    const created = await call('POST', `/leases/${LEASE}/inspections`, OWNER, {
      kind: 'incoming', scheduledFor: new Date().toISOString().slice(0, 10),
    });
    expect(created.status).toBe(201);
    inspectionId = created.body.id;
    const finding = { room: 'Kitchen', item: 'Sink and taps', condition: 'good' };
    expect((await call('PUT', `/inspections/${inspectionId}/findings`, OWNER, { findings: [finding] })).status).toBe(200);

    expect((await call('POST', `/inspections/${inspectionId}/render`, OWNER)).status).toBe(200);
    const first = (await draftKey())!;
    expect(existsSync(storage.localPathFor(first))).toBe(true);
    expect((await call('POST', `/inspections/${inspectionId}/render`, OWNER)).status).toBe(200);
    const second = (await draftKey())!;
    expect(second).not.toBe(first);
    expect(existsSync(storage.localPathFor(first))).toBe(false);
    expect(existsSync(storage.localPathFor(second))).toBe(true);

    expect((await call('PUT', `/inspections/${inspectionId}/findings`, OWNER, { findings: [{ ...finding, condition: 'fair' }] })).status).toBe(200);
    expect(await draftKey()).toBeNull();
    expect(existsSync(storage.localPathFor(second))).toBe(false);
  });

  it('40: refuses a room name too long for the index, and too many findings', async () => {
    const long = await call('PUT', `/inspections/${inspectionId}/findings`, OWNER, {
      findings: [{ room: 'x'.repeat(10_000), item: 'Walls', condition: 'good' }],
    });
    expect(long.status).toBe(400);
    const [had] = await db.query<{ n: number }>('select count(*)::int as n from inspection_finding where inspection_id = $1', [inspectionId]);
    const batch = (from: number) =>
      Array.from({ length: 120 }, (_, i) => ({ room: 'Room', item: `Item ${from + i}`, condition: 'good' }));
    // Fill up to the cap exactly, then one more is refused and nothing of that save is kept.
    let added = 0;
    while (had!.n + added + 120 <= 300) {
      expect((await call('PUT', `/inspections/${inspectionId}/findings`, OWNER, { findings: batch(added) })).status).toBe(200);
      added += 120;
    }
    const over = await call('PUT', `/inspections/${inspectionId}/findings`, OWNER, { findings: batch(added) });
    expect(over.status).toBe(409);
    const [count] = await db.query<{ n: number }>('select count(*)::int as n from inspection_finding where inspection_id = $1', [inspectionId]);
    expect(count!.n).toBe(had!.n + added);
  });
});

describe('34: unauthenticated PayFast notices are bounded', () => {
  const notify = async (body: string) => {
    const { handler } = await import('../handlers/billing-notify');
    return handler({
      body,
      isBase64Encoded: false,
      requestContext: { http: { method: 'POST', path: '/billing/notify', sourceIp: '203.0.113.9' } },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer) as Promise<{ statusCode: number }>;
  };

  it('keeps only a short summary of a notice that fails the signature, and nothing big', async () => {
    process.env.BILLING_DRIVER = 'payfast';
    process.env.PAYFAST_MERCHANT_ID = '10000100';
    process.env.PAYFAST_MERCHANT_KEY = '46f0cd694581a';
    process.env.PAYFAST_PASSPHRASE = 'jt7NOE43FZPn';
    try {
      const junk = Array.from({ length: 40 }, (_, i) => `junk${i}=${'y'.repeat(300)}`).join('&');
      expect((await notify(`pf_payment_id=${'1'.repeat(200)}&${junk}&signature=${'0'.repeat(32)}`)).statusCode).toBe(200);
      const [forged] = await db.query<{ payload: any; problem: string; external_id: string }>(
        `select payload, problem, external_id from billing_event where provider = 'payfast' order by created_at desc limit 1`,
      );
      expect(forged!.problem).toBe('Signature does not match.');
      expect(JSON.stringify(forged!.payload).length).toBeLessThan(400);
      expect(forged!.payload.source_ip).toBe('203.0.113.9');
      expect(forged!.external_id).toHaveLength(64);

      expect((await notify(`a=${'z'.repeat(20_000)}`)).statusCode).toBe(200);
      const [huge] = await db.query<{ payload: any; problem: string }>(
        `select payload, problem from billing_event where provider = 'payfast' order by created_at desc limit 1`,
      );
      expect(huge!.problem).toMatch(/Too large/);
      expect(JSON.stringify(huge!.payload).length).toBeLessThan(400);
    } finally {
      delete process.env.BILLING_DRIVER;
    }
  });

  it('stops storing unsigned notices from one address after a few', async () => {
    process.env.BILLING_DRIVER = 'payfast';
    process.env.PAYFAST_MERCHANT_ID = '10000100';
    process.env.PAYFAST_MERCHANT_KEY = '46f0cd694581a';
    process.env.PAYFAST_PASSPHRASE = 'jt7NOE43FZPn';
    try {
      const { handler } = await import('../handlers/billing-notify');
      const send = (n: number) => handler({
        body: `pf_payment_id=flood-${n}&signature=${'0'.repeat(32)}`,
        isBase64Encoded: false,
        requestContext: { http: { method: 'POST', path: '/billing/notify', sourceIp: '198.51.100.77' } },
      } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer) as Promise<{ statusCode: number }>;
      for (let n = 0; n < 60; n += 1) expect((await send(n)).statusCode).toBe(200);
      const [count] = await db.query<{ n: number }>(`select count(*)::int as n from billing_event where external_id like 'flood-%'`);
      expect(count!.n).toBeGreaterThan(0);
      expect(count!.n).toBeLessThanOrEqual(20);
    } finally {
      delete process.env.BILLING_DRIVER;
    }
  });

  it('caps the body the self-hosted server reads for it', () => {
    const source = readFileSync(join(API_ROOT, 'src/server.ts'), 'utf8');
    expect(source).toMatch(/'POST \/billing\/notify' \? NOTIFY_LIMIT : JSON_LIMIT/);
  });
});

describe('35 and 38: the attempt limiter', () => {
  it('counts an IPv6 address by its /64, and IPv4-mapped addresses as IPv4', async () => {
    const { AttemptLimiter, limiterKey } = await import('../lib/ratelimit');
    expect(limiterKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(limiterKey('2001:0db8:0001:0002::1')).toBe('2001:db8:1:2::/64');
    expect(limiterKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(limiterKey('::ffff:203.0.113.5')).toBe('203.0.113.5');
    expect(limiterKey('203.0.113.5')).toBe('203.0.113.5');
    expect(limiterKey('someone@example.co.za')).toBe('someone@example.co.za');
    expect(limiterKey('sub-landlord')).toBe('sub-landlord');
    expect(limiterKey('applicant:44444444-4444-4444-4444-444444444444')).toBe('applicant:44444444-4444-4444-4444-444444444444');

    const limiter = new AttemptLimiter(2, 60_000);
    limiter.record('2001:db8:1:2::10');
    limiter.record('2001:db8:1:2::11');
    expect(limiter.allows('2001:db8:1:2::12')).toBe(false);
    expect(limiter.allows('2001:db8:1:3::12')).toBe(true);
  });

  it('forgets keys that are never looked up again, and holds a bounded number', async () => {
    const { AttemptLimiter } = await import('../lib/ratelimit');
    let now = 0;
    const limiter = new AttemptLimiter(10, 1_000, () => now);
    for (let i = 0; i < 999; i += 1) limiter.record(`spray-${i}@example.co.za`);
    expect(limiter.size).toBe(999);
    now = 5_000;
    limiter.record('fresh@example.co.za');
    expect(limiter.size).toBe(1);

    const capped = new AttemptLimiter(10, 60_000, () => now, 50);
    for (let i = 0; i < 200; i += 1) capped.record(`key-${i}`);
    expect(capped.size).toBe(50);
    expect(capped.allows('key-199')).toBe(true);
    expect(capped.remaining('key-199')).toBe(9);
    expect(capped.remaining('key-0')).toBe(10);

    // At the cap, keys whose window has passed go before any live one, so a victim's counter
    // is not flushed while old junk is still held.
    now = 0;
    const swept = new AttemptLimiter(10, 1_000, () => now, 50);
    swept.record('victim@example.co.za');
    for (let i = 0; i < 48; i += 1) swept.record(`junk-${i}`);
    now = 900;
    swept.record('victim@example.co.za');
    now = 1_500;
    for (let i = 0; i < 10; i += 1) swept.record(`new-${i}`);
    expect(swept.remaining('victim@example.co.za')).toBe(9);
  });

  it('35: the Docker kit hands Caddy the visitor\'s IPv6 address', () => {
    const compose = parse(readFileSync(join(DEPLOY, 'docker-compose.yml'), 'utf8'));
    expect(compose.networks.edge.enable_ipv6).toBe(true);
    expect(compose.services.caddy.networks).toEqual(['edge']);
    expect(compose.services.app.networks).toEqual(['edge']);
  });
});

describe('36: confirmed uploads are capped too', () => {
  let applicationId: string;
  const presignOther = () =>
    call('POST', `/applications/${applicationId}/documents/presign`, OWNER, { kind: 'other', contentType: 'application/pdf', sizeBytes: PDF.length });

  it('keeps at most ten other documents on an application', async () => {
    const [application] = await db.query<{ id: string }>(`select id from application where status = 'submitted' limit 1`);
    applicationId = application!.id;
    for (let i = 0; i < 9; i += 1) {
      await db.query(
        `insert into application_document (application_id, kind, s3_key, content_type, size_bytes) values ($1, 'other', $2, 'application/pdf', 10)`,
        [applicationId, `applications/${applicationId}/other/${crypto.randomUUID()}.pdf`],
      );
    }
    // Two links issued while there was room for one more: only one of them is kept.
    const a = await presignOther();
    const b = await presignOther();
    expect([a.status, b.status]).toEqual([201, 201]);
    await storage.storage().put(a.body.key, PDF, 'application/pdf');
    await storage.storage().put(b.body.key, PDF, 'application/pdf');
    expect((await call('POST', `/applications/${applicationId}/documents/confirm`, OWNER, { key: a.body.key })).status).toBe(200);
    expect((await call('POST', `/applications/${applicationId}/documents/confirm`, OWNER, { key: b.body.key })).status).toBe(400);
    expect(existsSync(storage.localPathFor(b.body.key))).toBe(false);
    expect((await presignOther()).status).toBe(409);
  });

  it('keeps at most twenty photos per ticket stage', async () => {
    const [ticket] = await db.query<{ id: string }>(
      `insert into ticket (lease_id, category, severity, title, description, target_by, created_by)
       values ($1, 'plumbing', 'routine', 'Drip', 'The kitchen tap drips', now() + interval '7 days', 'sub-tenant') returning id`,
      [LEASE],
    );
    for (let i = 0; i < 20; i += 1) {
      await db.query(
        `insert into ticket_photo (ticket_id, phase, s3_key, content_type, size_bytes, uploaded) values ($1, 'report', $2, 'image/jpeg', 10, true)`,
        [ticket!.id, `tickets/${ticket!.id}/report-${crypto.randomUUID()}.jpg`],
      );
    }
    const presign = (phase: string) =>
      call('POST', `/tickets/${ticket!.id}/photos/presign`, TENANT, { phase, contentType: 'image/jpeg', sizeBytes: 1000 });
    expect((await presign('report')).status).toBe(409);
    expect((await presign('completion')).status).toBe(201);
  });

  it('checks the ticket photo cap again at confirm', async () => {
    const [ticket] = await db.query<{ id: string }>(
      `insert into ticket (lease_id, category, severity, title, description, target_by, created_by)
       values ($1, 'plumbing', 'routine', 'Leak', 'The geyser leaks', now() + interval '7 days', 'sub-tenant') returning id`,
      [LEASE],
    );
    // Links issued while there was still room: 19 kept, then two more confirmed late.
    for (let i = 0; i < 19; i += 1) {
      await db.query(
        `insert into ticket_photo (ticket_id, phase, s3_key, content_type, size_bytes, uploaded) values ($1, 'report', $2, 'image/jpeg', 10, true)`,
        [ticket!.id, `tickets/${ticket!.id}/report-${crypto.randomUUID()}.jpg`],
      );
    }
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
    const late: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const key = `tickets/${ticket!.id}/report-${crypto.randomUUID()}.png`;
      await storage.storage().put(key, png, 'image/png');
      const [row] = await db.query<{ id: string }>(
        `insert into ticket_photo (ticket_id, phase, s3_key, content_type, size_bytes, uploaded) values ($1, 'report', $2, 'image/png', 10, false) returning id`,
        [ticket!.id, key],
      );
      late.push(row!.id);
    }
    expect((await call('POST', '/photos/confirm', TENANT, { scope: 'ticket', photoId: late[0] })).status).toBe(200);
    expect((await call('POST', '/photos/confirm', TENANT, { scope: 'ticket', photoId: late[1] })).status).toBe(409);
    const [count] = await db.query<{ n: number }>(
      `select count(*)::int as n from ticket_photo where ticket_id = $1 and phase = 'report' and uploaded`, [ticket!.id],
    );
    expect(count!.n).toBe(20);
  });
});

describe('37: expense slips', () => {
  it('count against the upload-link allowance', async () => {
    const { uploadLinksByAccount } = await import('../lib/ratelimit');
    const before = uploadLinksByAccount.remaining('sub-landlord');
    const created = await call('POST', '/expenses', OWNER, {
      category: 'repairs', description: 'Tap washer', amountCents: 4_500, incurredOn: '2026-10-01',
      slip: { contentType: 'image/jpeg', sizeBytes: 1000 },
    });
    expect(created.status).toBe(201);
    expect(uploadLinksByAccount.remaining('sub-landlord')).toBe(before - 1);
  });

  it('are swept when never confirmed, and the expense stays', async () => {
    const [landlord] = await db.query<{ id: string }>(`select id from landlord where cognito_sub = 'sub-landlord'`);
    const raw = `expenses/${landlord!.id}/${crypto.randomUUID()}.jpg`;
    const kept = `expenses/${landlord!.id}/${crypto.randomUUID()}.kept.jpg`;
    await storage.storage().put(raw, new Uint8Array([1, 2, 3]), 'image/jpeg');
    const [stale] = await db.query<{ id: string }>(
      `insert into expense (landlord_id, category, description, amount_cents, incurred_on, slip_s3_key, created_by, created_at)
       values ($1, 'repairs', 'Old', 100, '2026-10-01', $2, 'sub-landlord', now() - interval '2 hours') returning id`,
      [landlord!.id, raw],
    );
    const [checked] = await db.query<{ id: string }>(
      `insert into expense (landlord_id, category, description, amount_cents, incurred_on, slip_s3_key, created_by, created_at)
       values ($1, 'repairs', 'Kept', 100, '2026-10-01', $2, 'sub-landlord', now() - interval '2 hours') returning id`,
      [landlord!.id, kept],
    );
    const { handler } = await import('../handlers/uploads-sweep');
    const result = await handler();
    expect(result.expenseSlips).toBeGreaterThanOrEqual(1);
    expect(existsSync(storage.localPathFor(raw))).toBe(false);
    const rows = await db.query<{ id: string; slip_s3_key: string | null }>(
      'select id, slip_s3_key from expense where id = any($1) order by description desc',
      [[stale!.id, checked!.id]],
    );
    expect(rows).toEqual([
      { id: stale!.id, slip_s3_key: null },
      { id: checked!.id, slip_s3_key: kept },
    ]);
  });

  it('leaves slips from before the confirm step alone', async () => {
    // Expenses made before slips were confirmed kept their raw key; those are real receipts.
    const [landlord] = await db.query<{ id: string }>(`select id from landlord where cognito_sub = 'sub-landlord'`);
    const raw = `expenses/${landlord!.id}/${crypto.randomUUID()}.jpg`;
    await storage.storage().put(raw, new Uint8Array([1, 2, 3]), 'image/jpeg');
    const [old] = await db.query<{ id: string }>(
      `insert into expense (landlord_id, category, description, amount_cents, incurred_on, slip_s3_key, created_by, created_at)
       values ($1, 'repairs', 'Legacy', 100, '2025-10-01', $2, 'sub-landlord', now() - interval '200 days') returning id`,
      [landlord!.id, raw],
    );
    const { handler } = await import('../handlers/uploads-sweep');
    await handler();
    expect(existsSync(storage.localPathFor(raw))).toBe(true);
    const [row] = await db.query<{ slip_s3_key: string | null }>('select slip_s3_key from expense where id = $1', [old!.id]);
    expect(row!.slip_s3_key).toBe(raw);
  });
});

describe('39: list query parameters are checked before any SQL runs', () => {
  it('answers 400, not 500, to a bad limit, date or id', async () => {
    for (const path of [
      '/applications?limit=abc',
      '/applications?limit=-1',
      '/applications?limit=500',
      '/expenses?propertyId=x',
      `/expenses?propertyId=${'-'.repeat(36)}`,
      '/expenses?propertyId=0123456789abcdef0123456789abcdef----',
      '/expenses?from=2026-99-99',
      '/reports/income-expense?from=2026-13-45&to=2026-14-01',
    ]) {
      const response = await call('GET', path, OWNER);
      expect([path, response.status]).toEqual([path, 400]);
    }
    expect((await call('GET', '/applications?limit=10', OWNER)).status).toBe(200);
    expect((await call('GET', '/expenses?from=2026-01-01&to=2026-12-31', OWNER)).status).toBe(200);
  });
});

describe('66, 67 and 73: the scheduled Lambda functions', () => {
  const config = parse(readFileSync(join(API_ROOT, 'serverless.yml'), 'utf8'));

  it('run at the self-hosted scheduler\'s times, through handlers that ignore the event', async () => {
    const { JOBS } = await import('../lib/scheduler');
    const scheduled = await import('../handlers/scheduled');
    const seen: string[] = [];
    for (const [name, fn] of Object.entries<any>(config.functions)) {
      const schedule = (fn.events ?? []).find((event: any) => event.schedule)?.schedule as string | undefined;
      if (!schedule) continue;
      const [file, exported] = String(fn.handler).split('.');
      expect(file).toBe('src/handlers/scheduled');
      expect(typeof (scheduled as Record<string, unknown>)[exported!]).toBe('function');
      const job = JOBS.find((candidate) => candidate.name.replace(/-(\w)/g, (_, c: string) => c.toUpperCase()) === exported);
      expect(job, name).toBeTruthy();
      seen.push(job!.name);
      if (job!.everyMinutes) {
        expect(schedule).toBe(job!.everyMinutes === 60 ? 'rate(1 hour)' : `rate(${job!.everyMinutes} minutes)`);
        continue;
      }
      const cron = /^cron\((\d+) (\d+) \* \* \? \*\)$/.exec(schedule);
      expect(cron, `${name} runs daily`).toBeTruthy();
      const sast = `${String((Number(cron![2]) + 2) % 24).padStart(2, '0')}:${cron![1]!.padStart(2, '0')}`;
      expect([name, sast]).toEqual([name, job!.dailyAt]);
    }
    expect(seen.sort()).toEqual(JOBS.map((job) => job.name).sort());
  });

  it('arrears-run survives the EventBridge event and records the run for /health', async () => {
    const { arrearsRun } = await import('../handlers/scheduled');
    const event = { version: '0', id: 'x', 'detail-type': 'Scheduled Event', source: 'aws.events', time: new Date().toISOString(), detail: {} };
    await (arrearsRun as unknown as (event: unknown) => Promise<unknown>)(event);
    const rows = await db.query<{ why: string }>(
      `select detail->>'why' as why from audit_log where action = 'job.finished' and detail->>'job' = 'arrears-run'`,
    );
    expect(rows.map((row) => row.why)).toContain('scheduled');
  });

  it('lets the uptime monitor reach /health without a token', () => {
    const open = (config.functions.api.events as any[]).filter((event) => event.httpApi && !event.httpApi.authorizer);
    expect(open.map((event) => `${event.httpApi.method} ${event.httpApi.path}`)).toContain('GET /health');
  });
});

describe('68: migrating a database that holds duplicate deductions', () => {
  it('cleans them up before 0037 adds its unique index', async () => {
    const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql') && !n.includes('seed')).sort();
    const before = all.filter((n) => n < '0036a');
    const after = all.filter((n) => n >= '0036a');
    expect(after[0]).toBe('0036a_dedupe_deductions.sql');
    const pg = await PGlite.create();
    for (const file of before) await pg.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
    const seeds = readdirSync(MIGRATIONS).filter((n) => n.includes('seed') && n < '0036a').sort();
    for (const file of seeds) {
      await pg.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
    }
    const one = async (sql: string, params: unknown[] = []) => (await pg.query<{ id: string }>(sql, params)).rows[0]!.id;
    const inspection = await one(
      `insert into inspection (lease_id, kind, scheduled_for, status) values ($1, 'outgoing', current_date, 'completed') returning id`,
      [LEASE],
    );
    const finding = await one(
      `insert into inspection_finding (inspection_id, room, item, condition) values ($1, 'Kitchen', 'Sink', 'damaged') returning id`,
      [inspection],
    );
    const open = await one(
      `insert into termination (lease_id, initiated_by, reason, notice_given_on, effective_on, notice_days, status)
       values ($1, 'tenant', 'end_of_term', current_date, current_date, 20, 'reconciling') returning id`,
      [LEASE],
    );
    for (let i = 0; i < 3; i += 1) {
      await pg.query(
        `insert into deposit_deduction (termination_id, finding_id, description, amount_cents, created_at)
         values ($1, $2, 'Sink', 10000, now() + make_interval(secs => $3))`,
        [open, finding, i],
      );
    }
    for (const file of after) await pg.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
    const left = await pg.query<{ n: number }>(`select count(*)::int as n from deposit_deduction where termination_id = $1`, [open]);
    expect(left.rows[0]!.n).toBe(1);
    await pg.close();
  }, 60_000);

  it('keeps a settled termination\'s deductions, unlinked', () => {
    const sql = readFileSync(join(MIGRATIONS, '0036a_dedupe_deductions.sql'), 'utf8');
    expect(sql).toMatch(/set finding_id = null[\s\S]*status = 'settled'/);
  });
});

describe('69, 70 and 71: the backup and restore scripts', () => {
  const backup = readFileSync(join(DEPLOY, 'backup.sh'), 'utf8');
  const restore = readFileSync(join(DEPLOY, 'restore.sh'), 'utf8');

  it('69: leaves restore leftovers out of a backup, and out of what a restore moves in', () => {
    expect(backup).toMatch(/--exclude=storage\/\.restore-prev/);
    const moveIn = restore.split('\n').find((line) => line.includes('find .restore-new/storage'))!;
    expect(moveIn).toMatch(/! -name \.restore-prev/);
  });

  it('70: does not count failed sign-ins the privacy sweep deletes', () => {
    expect(backup).toMatch(/audit_log \] && count="\$count where action <> 'auth\.login_failed'"/);
  });

  it('71: stops before anything changes when an earlier restore left tms_previous', () => {
    const guard = restore.indexOf("datname = 'tms_previous'");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(restore.indexOf('Type RESTORE to go on'));
    expect(restore).not.toMatch(/dropdb --if-exists tms_previous/);
  });
});
