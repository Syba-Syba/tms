import { beforeAll, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

/** Audit round 5, hardening batch: findings 10, 15-17, 26-36 and 55. */

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '../../../db/migrations');
const API_ROOT = join(HERE, '../..');
const LEASE = '66666666-6666-6666-6666-666666666666';

type As = { sub: string; groups: string };
const OWNER: As = { sub: 'sub-landlord', groups: 'landlord' };
const TENANT: As = { sub: 'sub-tenant', groups: 'tenant' };
let call: (method: string, path: string, as: As, body?: unknown) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let storage: typeof import('../lib/storage');

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://hardening5-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.AUTH_DRIVER = 'local';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'tms-hardening5-'));
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
        http: { method, path, sourceIp: `10.55.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`, userAgent: 'test' },
        authorizer: { jwt: { claims: { sub: as.sub, 'cognito:groups': `[${as.groups}]` } } },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
    const result = (await handler(event)) as { statusCode: number; body?: string };
    return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : null };
  };
}, 120_000);

/* A real PNG: greyscale, 8 bit, every pixel zero. Tiny on disk at any size. */
function crc32(bytes: Buffer) {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
function chunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
function png(width: number, height: number) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const raw = Buffer.alloc((width + 1) * height);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const dataUrl = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`;
const SIGNATURE = dataUrl(png(300, 100));
const PDF = new TextEncoder().encode('%PDF-1.4\n%drill\n');

const today = () => new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 10);
const daysFrom = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

async function newInspection(kind: 'incoming' | 'outgoing' = 'incoming') {
  await db.query(`delete from deposit_deduction where finding_id in
    (select f.id from inspection_finding f join inspection i on i.id = f.inspection_id where i.lease_id = $1)`, [LEASE]);
  await db.query(`delete from inspection where lease_id = $1`, [LEASE]);
  const [row] = await db.query<{ id: string }>(
    `insert into inspection (lease_id, kind, scheduled_for) values ($1, $2, $3) returning id`,
    [LEASE, kind, today()],
  );
  const id = row!.id;
  expect((await call('PUT', `/inspections/${id}/findings`, OWNER, {
    findings: [{ room: 'Kitchen', item: 'Sink and taps', condition: 'good' }],
  })).status).toBe(200);
  return id;
}
const render = async (id: string) => {
  const result = await call('POST', `/inspections/${id}/render`, OWNER);
  expect(result.status).toBe(200);
  return result.body.sha256 as string;
};
const sign = (id: string, party: 'landlord' | 'tenant', pdfSha256: string, signatureBase64 = SIGNATURE) =>
  call('POST', `/inspections/${id}/signature`, party === 'landlord' ? OWNER : TENANT, { party, signatureBase64, pdfSha256 });

describe('26: a signature image that cannot be decoded', () => {
  it('is refused when it is submitted', async () => {
    const id = await newInspection();
    const sha = await render(id);
    const junk = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
    expect((await sign(id, 'tenant', sha, dataUrl(junk))).status).toBe(400);
    // Truncated: a real header and nothing after it.
    expect((await sign(id, 'tenant', sha, dataUrl(png(300, 100).subarray(0, 60)))).status).toBe(400);
    expect(await db.query('select 1 from inspection_signature where inspection_id = $1', [id])).toHaveLength(0);
  });

  it('already on file does not block the seal for good', async () => {
    const id = await newInspection();
    const sha = await render(id);
    expect((await sign(id, 'landlord', sha)).status).toBe(200);
    // A signature stored before the check existed.
    await storage.storage().put(`inspections/${id}/signature-landlord.png`, Buffer.concat([png(10, 10).subarray(0, 8), Buffer.alloc(120, 1)]), 'image/png');
    const second = await sign(id, 'tenant', sha);
    expect(second.status).toBe(200);
    expect(second.body.status).toBe('completed');
  });
});

describe('27: images too large to decode are refused from the header', () => {
  it('reads PNG and JPEG dimensions without decoding', async () => {
    const { imageDimensions, hasSafeDimensions } = await import('../lib/images');
    expect(imageDimensions(png(321, 123))).toEqual({ width: 321, height: 123 });
    // SOI, an APP0 segment, then SOF0 with height 480 and width 640.
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
      0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x01, 0x01, 0x11, 0x00,
    ]);
    expect(imageDimensions(jpeg)).toEqual({ width: 640, height: 480 });
    expect(hasSafeDimensions(png(6000, 6000))).toBe(false);
    expect(hasSafeDimensions(png(1600, 1200))).toBe(true);
  });

  it('refuses a decompression bomb at photo confirm, before decoding it', async () => {
    const id = await newInspection();
    const presign = await call('POST', `/inspections/${id}/photos/presign`, TENANT, {
      room: 'Kitchen', item: 'Sink and taps', contentType: 'image/png', sizeBytes: 1000,
    });
    expect(presign.status).toBe(201);
    await storage.storage().put(presign.body.key, png(6000, 6000), 'image/png');
    const confirmed = await call('POST', '/photos/confirm', TENANT, { scope: 'inspection', photoId: presign.body.photoId });
    expect(confirmed.status).toBe(400);
  }, 30_000);

  it('refuses a truncated PNG photo without handing it to the decoder, which never returns on one', async () => {
    const { isWellFormedPng } = await import('../lib/images');
    const whole = png(300, 100);
    expect(isWellFormedPng(whole)).toBe(true);
    expect(isWellFormedPng(whole.subarray(0, 60))).toBe(false);
    expect(isWellFormedPng(whole.subarray(0, whole.length - 12))).toBe(false);
    const id = await newInspection();
    const presign = await call('POST', `/inspections/${id}/photos/presign`, TENANT, {
      room: 'Kitchen', item: 'Sink and taps', contentType: 'image/png', sizeBytes: 100,
    });
    await storage.storage().put(presign.body.key, whole.subarray(0, 60), 'image/png');
    expect((await call('POST', '/photos/confirm', TENANT, { scope: 'inspection', photoId: presign.body.photoId })).status).toBe(400);
  });

  it('refuses an oversized signature before it is stored', async () => {
    const id = await newInspection();
    const sha = await render(id);
    expect((await sign(id, 'tenant', sha, dataUrl(png(6000, 6000)))).status).toBe(400);
  });
});

describe('10: a tenant who stayed away cannot reopen the landlord\'s solo-signed exit report', () => {
  async function soloSigned(scheduledFor: string, kind: 'incoming' | 'outgoing' = 'outgoing') {
    await db.query(`delete from inspection where lease_id = $1`, [LEASE]);
    const [row] = await db.query<{ id: string }>(
      `insert into inspection (lease_id, kind, scheduled_for, status, draft_sha256, created_at)
       values ($1, $3, $2, 'awaiting_signatures', 'abc', now() - interval '10 days') returning id`,
      [LEASE, scheduledFor, kind],
    );
    await db.query(
      `insert into inspection_signature (inspection_id, party, signature_s3_key, pdf_sha256) values ($1, 'landlord', 'x.png', 'abc')`,
      [row!.id],
    );
    return row!.id;
  }

  it('refuses the tenant once the landlord signed alone after the booked date', async () => {
    const id = await soloSigned(daysFrom(today(), -1));
    expect((await call('POST', `/inspections/${id}/reopen`, TENANT)).status).toBe(409);
    expect(await db.query('select 1 from inspection_signature where inspection_id = $1', [id])).toHaveLength(1);
    // The landlord may still reopen their own report.
    expect((await call('POST', `/inspections/${id}/reopen`, OWNER)).status).toBe(200);
  });

  it('still lets the tenant reopen on the day itself, when they could have been there', async () => {
    const id = await soloSigned(today());
    expect((await call('POST', `/inspections/${id}/reopen`, TENANT)).status).toBe(200);
  });

  it('still lets the tenant reopen a move-in inspection in the same state, to dispute the baseline', async () => {
    const id = await soloSigned(daysFrom(today(), -1), 'incoming');
    expect((await call('POST', `/inspections/${id}/reopen`, TENANT)).status).toBe(200);
  });
});

describe('29 and 34: inspection photos', () => {
  const presign = (id: string) =>
    call('POST', `/inspections/${id}/photos/presign`, TENANT, { room: 'Kitchen', item: 'Sink and taps', contentType: 'image/png', sizeBytes: 100 });
  const findingOf = async (id: string) =>
    (await db.query<{ id: string }>('select id from inspection_finding where inspection_id = $1', [id]))[0]!.id;

  it('caps confirmed photos per finding, at presign and again at confirm', async () => {
    const id = await newInspection();
    const finding = await findingOf(id);
    const { MAX_INSPECTION_PHOTOS_PER_FINDING } = await import('../handlers/inspections-photo-presign');
    const link = await presign(id);
    expect(link.status).toBe(201);
    for (let i = 0; i < MAX_INSPECTION_PHOTOS_PER_FINDING; i += 1) {
      await db.query(
        `insert into inspection_photo (finding_id, s3_key, content_type, size_bytes, uploaded) values ($1, $2, 'image/png', 10, true)`,
        [finding, `inspections/${id}/${crypto.randomUUID()}.kept.png`],
      );
    }
    expect((await presign(id)).status).toBe(409);
    await storage.storage().put(link.body.key, png(20, 20), 'image/png');
    expect((await call('POST', '/photos/confirm', TENANT, { scope: 'inspection', photoId: link.body.photoId })).status).toBe(409);
    expect(existsSync(storage.localPathFor(link.body.key.replace(/\.png$/, '.kept.png')))).toBe(false);
  });

  it('leaves no kept copy behind when the inspection closed before the confirm', async () => {
    const id = await newInspection();
    const link = await presign(id);
    await storage.storage().put(link.body.key, png(20, 20), 'image/png');
    await db.query(`update inspection set status = 'awaiting_signatures' where id = $1`, [id]);
    expect((await call('POST', '/photos/confirm', TENANT, { scope: 'inspection', photoId: link.body.photoId })).status).toBe(409);
    expect(existsSync(storage.localPathFor(link.body.key.replace(/\.png$/, '.kept.png')))).toBe(false);
  });
});

describe('28: ticket creation is rate limited', () => {
  it('refuses a loop of tickets from one account', async () => {
    const body = { category: 'plumbing', severity: 'routine', title: 'Dripping tap', description: 'The kitchen tap drips all night.' };
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) statuses.push((await call('POST', `/leases/${LEASE}/tickets`, TENANT, body)).status);
    expect(statuses.slice(0, 10).every((status) => status === 201)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it('refuses a new ticket once the lease has too many open, and allows one again after a close', async () => {
    const { MAX_OPEN_TICKETS } = await import('../handlers/tickets-create');
    const limits = await import('../lib/ratelimit');
    for (const limiter of [limits.ticketsByAccountHourly, limits.ticketsByAccountDaily]) {
      (limiter as unknown as { attempts: Map<string, number[]> }).attempts.clear();
    }
    const open = await db.query<{ count: string }>(
      `select count(*)::text as count from ticket where lease_id = $1 and status not in ('done', 'closed', 'cancelled')`, [LEASE]);
    const body = { category: 'plumbing', severity: 'routine', title: 'Dripping tap', description: 'The kitchen tap drips all night.' };
    const [model] = await db.query<{ id: string }>(`select id from ticket where lease_id = $1 limit 1`, [LEASE]);
    for (let i = Number(open[0]!.count); i < MAX_OPEN_TICKETS; i += 1) {
      await db.query(
        `insert into ticket (lease_id, category, severity, title, description, status, target_by, created_by)
         select lease_id, category, severity, title, description, 'open', target_by, created_by from ticket where id = $1`, [model!.id]);
    }
    expect((await call('POST', `/leases/${LEASE}/tickets`, TENANT, body)).status).toBe(409);
    await db.query(`update ticket set status = 'closed' where id = $1`, [model!.id]);
    expect((await call('POST', `/leases/${LEASE}/tickets`, TENANT, body)).status).toBe(201);
  });
});

describe('15, 16, 32, 33: application documents', () => {
  let applicationId: string;
  const presign = (as: As, kind: string) =>
    call('POST', `/applications/${applicationId}/documents/presign`, as, { kind, contentType: 'application/pdf', sizeBytes: PDF.length });

  beforeAll(async () => {
    const [application] = await db.query<{ id: string; sub: string }>(
      `select a.id, ap.cognito_sub as sub from application a join applicant ap on ap.id = a.applicant_id
        where a.status = 'submitted' and ap.cognito_sub is not null limit 1`,
    );
    applicationId = application!.id;
    APPLICANT.sub = application!.sub;
  });
  const APPLICANT: As = { sub: '', groups: 'tenant' };

  it('16: only the applicant files their own ID copy, payslip or bank statement', async () => {
    expect((await presign(OWNER, 'payslip')).status).toBe(403);
    // A key the landlord could not have been issued, confirmed anyway.
    const key = `applications/${applicationId}/id_copy/${crypto.randomUUID()}.pdf`;
    await storage.storage().put(key, PDF, 'application/pdf');
    expect((await call('POST', `/applications/${applicationId}/documents/confirm`, OWNER, { key })).status).toBe(403);
  });

  it('15/32: keeps a checked copy under a key no upload link names, and drops the upload', async () => {
    const link = await presign(APPLICANT, 'payslip');
    expect(link.status).toBe(201);
    await storage.storage().put(link.body.key, PDF, 'application/pdf');
    const confirm = () => call('POST', `/applications/${applicationId}/documents/confirm`, APPLICANT, { key: link.body.key });
    expect((await confirm()).status).toBe(200);
    const [row] = await db.query<{ s3_key: string; size_bytes: string }>(
      `select s3_key, size_bytes from application_document where application_id = $1 and kind = 'payslip'`,
      [applicationId],
    );
    expect(row!.s3_key).toBe(link.body.key.replace(/\.pdf$/, '.kept.pdf'));
    expect(Number(row!.size_bytes)).toBe(PDF.length);
    expect(existsSync(storage.localPathFor(row!.s3_key))).toBe(true);
    expect(existsSync(storage.localPathFor(link.body.key))).toBe(false);
    // A retried confirm is still one document.
    expect((await confirm()).status).toBe(200);
    expect(await db.query(`select 1 from application_document where application_id = $1 and kind = 'payslip'`, [applicationId])).toHaveLength(1);
    // The sweep leaves the kept copy alone.
    await db.query(`update pending_upload set created_at = now() - interval '2 hours' where s3_key = $1`, [link.body.key]);
    const { handler: sweep } = await import('../handlers/uploads-sweep');
    await sweep();
    expect(existsSync(storage.localPathFor(row!.s3_key))).toBe(true);
  });

  it('40: accepts a PDF for every applicant kind', async () => {
    for (const kind of ['id_copy', 'bank_statement', 'proof_of_address']) {
      const link = await presign(APPLICANT, kind);
      expect(link.status).toBe(201);
      await storage.storage().put(link.body.key, PDF, 'application/pdf');
      expect((await call('POST', `/applications/${applicationId}/documents/confirm`, APPLICANT, { key: link.body.key })).status).toBe(200);
    }
  });

  it('33: keeps the pending entry when its file could not be removed', async () => {
    const key = `applications/${applicationId}/other/${crypto.randomUUID()}.pdf`;
    await db.query(
      `insert into pending_upload (s3_key, application_id, created_by, created_at) values ($1, $2, 'x', now() - interval '2 hours')`,
      [key, applicationId],
    );
    // A directory where the file should be: removing it fails.
    mkdirSync(storage.localPathFor(key), { recursive: true });
    writeFileSync(join(storage.localPathFor(key), 'inside'), 'x');
    const { handler: sweep } = await import('../handlers/uploads-sweep');
    await sweep();
    expect(await db.query('select 1 from pending_upload where s3_key = $1', [key])).toHaveLength(1);
  });
});

describe('30, 31, 35: bank statements', () => {
  it('35: refuses an amount too large to be one', async () => {
    const { parseAmount } = await import('../domain/bank-statement');
    expect(parseAmount('99999999999999999999.00')).toBeNull();
    expect(parseAmount('1234567890123')).toBeNull();
    expect(parseAmount('150000.00')).toBe(15_000_000);
  });

  it('30: refuses a statement with too many credit lines', async () => {
    const { parseStatement, StatementError, MAX_STATEMENT_LINES } = await import('../domain/bank-statement');
    const rows = ['Date,Amount,Description'];
    for (let i = 0; i <= MAX_STATEMENT_LINES; i += 1) rows.push(`2026/01/05,1.00,x`);
    expect(() => parseStatement('s.csv', rows.join('\n'))).toThrow(StatementError);
  });

  it('30: imports a statement in one insert and skips lines already on file', async () => {
    const rows = ['Date,Amount,Description'];
    for (let i = 0; i < 300; i += 1) rows.push(`2026/02/05,${100 + i}.00,Rent ${i}`);
    const content = rows.join('\n');
    const first = await call('POST', '/bank-imports', OWNER, { fileName: 'feb.csv', content });
    expect(first.status).toBe(201);
    expect(first.body.summary.added).toBe(300);
    const again = await call('POST', '/bank-imports', OWNER, { fileName: 'feb.csv', content });
    expect(again.body.summary).toMatchObject({ added: 0, alreadyImported: 300 });
  });

  it('31: OFX lines from two accounts with the same FITID are both kept, and old imports still match', async () => {
    const ofx = (account: string, amount: string) => `<OFX><BANKACCTFROM><ACCTID>${account}</BANKACCTFROM><BANKTRANLIST>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260310<TRNAMT>${amount}<FITID>F1<NAME>Rent A1</STMTTRN></BANKTRANLIST></OFX>`;
    const one = await call('POST', '/bank-imports', OWNER, { fileName: 'a.ofx', content: ofx('111', '5000.00') });
    expect(one.body.summary.added).toBe(1);
    const two = await call('POST', '/bank-imports', OWNER, { fileName: 'b.ofx', content: ofx('222', '7000.00') });
    expect(two.body.summary.added).toBe(1);
    expect((await call('POST', '/bank-imports', OWNER, { fileName: 'a.ofx', content: ofx('111', '5000.00') })).body.summary.added).toBe(0);

    // A line imported before the account was part of the fingerprint is not imported again.
    const { createHash } = await import('node:crypto');
    const legacy = createHash('sha256').update(['fitid', 'F9'].join('\u001f')).digest('hex').slice(0, 32);
    const [imp] = await db.query<{ id: string; landlord_id: string }>(
      `select id, landlord_id from bank_import order by created_at desc limit 1`,
    );
    await db.query(
      `insert into bank_line (import_id, landlord_id, posted_on, amount_cents, description, fingerprint)
       values ($1, $2, '2026-03-11', 800000, 'Rent B2', $3)`,
      [imp!.id, imp!.landlord_id, legacy],
    );
    const old = `<OFX><BANKACCTFROM><ACCTID>111</BANKACCTFROM><STMTTRN><DTPOSTED>20260311<TRNAMT>8000.00<FITID>F9<NAME>Rent B2</STMTTRN></OFX>`;
    expect((await call('POST', '/bank-imports', OWNER, { fileName: 'c.ofx', content: old })).body.summary.added).toBe(0);
  });
});

describe('36: tenancy import invites respect the per-recipient cap', () => {
  it('refuses an import that would send one address more invitations than a day allows', async () => {
    const start = daysFrom(today(), -400);
    const end = daysFrom(today(), 300);
    const rows = ['Q1', 'Q2', 'Q3', 'Q4'].map((unit) => ({
      property: 'Kruis Court', unit, firstName: 'Vic', lastName: 'Tim', email: 'victim@example.co.za',
      phone: '0821234567', startDate: start, endDate: end, monthlyRentCents: 500000, currentMonthPaid: true, bedrooms: 1, bathrooms: 1,
    }));
    const result = await call('POST', '/leases/import', OWNER, { rows, dryRun: false, invite: true });
    expect(result.body.results?.flatMap((row: { problems: string[] }) => row.problems) ?? []).toEqual([]);
    expect(result.status).toBe(429);
    const two = await call('POST', '/leases/import', OWNER, { rows: rows.slice(0, 2), dryRun: false, invite: true });
    expect(two.status).toBe(201);
    // Two of three used: two more would go past the cap.
    const more = await call('POST', '/leases/import', OWNER, {
      rows: rows.slice(2).map((row, i) => ({ ...row, unit: `R${i}` })), dryRun: false, invite: true,
    });
    expect(more.status).toBe(429);
  });
});

describe('17 and 55: the self-hosted server', () => {
  it('refuses a second PUT to a spent upload key, and answers /health with health', async () => {
    const { spawn } = await import('node:child_process');
    const { createHmac, randomBytes } = await import('node:crypto');
    const secret = randomBytes(32).toString('hex');
    const files = mkdtempSync(join(tmpdir(), 'tms-files5-'));
    const port = 41_000 + Math.floor(Math.random() * 900);
    const child = spawn(join(API_ROOT, '../../node_modules/.bin/tsx'), ['src/server.ts'], {
      cwd: API_ROOT,
      env: {
        ...process.env, NODE_ENV: 'production', APP_MODE: 'self-hosted', AUTH_DRIVER: 'local', STORAGE_DRIVER: 'local',
        STORAGE_DIR: files, AUTH_SECRET: randomBytes(32).toString('hex'), PGLITE_DIR: 'memory://server5',
        STORAGE_SECRET: secret, RUN_JOBS: 'false', PORT: String(port), DB_DRIVER: 'pglite',
        DB_HOST: 'x', DB_NAME: 'x', DB_SECRET_ARN: 'x', DOCS_BUCKET: 'x', KMS_KEY_ID: 'x', WEB_ROOT: files,
      },
      stdio: 'ignore',
    });
    try {
      const base = `http://127.0.0.1:${port}`;
      for (let i = 0; i < 80; i += 1) {
        const up = await fetch(`${base}/files/x`).then((r) => r.status).catch(() => 0);
        if (up !== 0) break;
        await new Promise((done) => setTimeout(done, 250));
      }
      const urlFor = (key: string) => {
        const expires = Math.floor(Date.now() / 1000) + 300;
        const sig = createHmac('sha256', secret).update(`PUT\n${key}\n${expires}`).digest('hex');
        return `${base}/files/${key}?exp=${expires}&sig=${sig}`;
      };
      // Confirmed: the checked copy stands and the raw upload was removed.
      mkdirSync(join(files, 'tickets/t'), { recursive: true });
      writeFileSync(join(files, 'tickets/t/photo.kept.jpg'), 'checked');
      expect(await fetch(urlFor('tickets/t/photo.jpg'), { method: 'PUT', body: 'again' }).then((r) => r.status)).toBe(409);
      expect(existsSync(join(files, 'tickets/t/photo.jpg'))).toBe(false);
      expect(await fetch(urlFor('tickets/t/other.jpg'), { method: 'PUT', body: 'fresh' }).then((r) => r.status)).toBe(204);

      writeFileSync(join(files, 'index.html'), '<!doctype html><title>app</title>');
      const page = await fetch(`${base}/health`, { headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' } });
      expect(page.headers.get('content-type')).toMatch(/json/);
      // The database here has no tables, so health may fail; what matters is that it answered.
      const text = await page.text();
      expect(text).not.toMatch(/<!doctype/i);
      expect(() => JSON.parse(text)).not.toThrow();
      const head = await fetch(`${base}/health`, { method: 'HEAD' });
      expect(head.status).not.toBe(404);
    } finally {
      child.kill();
    }
  }, 40_000);
});
