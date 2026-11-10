import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { PRIVACY_VERSION } from '../domain/privacy';

/** Audit round 6, area B (access, privacy, abuse, hosting): findings 1-3 and 5-9. */

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '../../../db/migrations');
const DEPLOY = join(HERE, '../../../../deploy');
const HANDLERS = join(HERE, '../handlers');
const LEASE = '66666666-6666-6666-6666-666666666666';
const SEED_LANDLORD = '11111111-1111-1111-1111-111111111111';

type As = { sub: string; groups: string };
const OWNER: As = { sub: 'sub-landlord', groups: 'landlord' };
const TENANT: As = { sub: 'sub-tenant', groups: 'tenant' };
let call: (method: string, path: string, as: As | null, body?: unknown, rawBody?: string) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let storage: typeof import('../lib/storage');
let images: typeof import('../lib/images');
let pdf: typeof import('../lib/pdf');
let privacy: typeof import('../lib/privacy');
let seedProperty: string;

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://security6-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.AUTH_DRIVER = 'local';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'tms-security6-'));
  process.env.KMS_DRIVER = 'local';
  db = await import('../lib/db');
  storage = await import('../lib/storage');
  images = await import('../lib/images');
  pdf = await import('../lib/pdf');
  privacy = await import('../lib/privacy');
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  for (const file of all.filter((n) => !n.includes('seed'))) await db.execScript(read(file));
  for (const file of all.filter((n) => n.includes('seed'))) await db.execScript(read(file));
  seedProperty = (await db.query<{ property_id: string }>(
    `select u.property_id from unit u join property p on p.id = u.property_id where p.landlord_id = $1 limit 1`,
    [SEED_LANDLORD],
  ))[0]!.property_id;
  const { handler } = await import('../api');
  let ip = 0;
  call = async (method, fullPath, as, body, rawBody) => {
    const [path = fullPath, search] = fullPath.split('?');
    const event = {
      rawPath: path,
      headers: { 'content-type': 'application/json' },
      queryStringParameters: Object.fromEntries(new URLSearchParams(search ?? '')),
      pathParameters: {},
      body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
      requestContext: {
        http: { method, path, sourceIp: `10.66.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`, userAgent: 'test' },
        authorizer: { jwt: { claims: { sub: as?.sub ?? 'anonymous', 'cognito:groups': `[${as?.groups ?? 'tenant'}]` } } },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
    const result = (await handler(event)) as { statusCode: number; body?: string };
    return { status: result.statusCode, body: result.body ? JSON.parse(result.body) : null };
  };
}, 120_000);

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.JOBS_HELD_SINCE;
  delete process.env.RUN_JOBS;
});

/* PNG building blocks. Greyscale, 8 bit, every pixel zero: tiny on disk at any size. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
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
function ihdr(width: number, height: number) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8; // bit depth
  data[9] = 0; // greyscale
  return chunk('IHDR', data);
}
const idat = (width: number, height: number) => chunk('IDAT', deflateSync(Buffer.alloc((width + 1) * height)));
const IEND = chunk('IEND', Buffer.alloc(0));
const png = (width: number, height: number, extra: Buffer[] = []) =>
  Buffer.concat([PNG_MAGIC, ihdr(width, height), ...extra, idat(width, height), IEND]);
/** An animation frame header: sequence, width, height, x, y, delay, dispose, blend. */
function fctl(sequence: number, width: number, height: number) {
  const data = Buffer.alloc(26);
  data.writeUInt32BE(sequence, 0);
  data.writeUInt32BE(width, 4);
  data.writeUInt32BE(height, 8);
  data.writeUInt16BE(1, 20);
  data.writeUInt16BE(10, 22);
  return chunk('fcTL', data);
}
function actl(frames: number) {
  const data = Buffer.alloc(8);
  data.writeUInt32BE(frames, 0);
  return chunk('acTL', data);
}
function fdat(sequence: number, width: number, height: number) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(sequence);
  return chunk('fdAT', Buffer.concat([head, deflateSync(Buffer.alloc((width + 1) * height))]));
}

/* The three files from the audit. Each is a valid 10x10 PNG to a reader of the first IHDR. */
/** A second IHDR: the decoder used the later one, 8000x8000. */
const SECOND_IHDR = Buffer.concat([PNG_MAGIC, ihdr(10, 10), ihdr(8000, 8000), idat(10, 10), IEND]);
/** Animated, with one 20000x20000 frame: decoded in full before "animated PNGs are not supported". */
const HUGE_FRAME = Buffer.concat([
  PNG_MAGIC, ihdr(10, 10), actl(2), fctl(0, 10, 10), idat(10, 10), fctl(1, 20000, 20000), fdat(2, 4, 4), IEND,
]);
/** Animated, 200 frames of 1000x1000. */
const MANY_FRAMES = Buffer.concat([
  PNG_MAGIC, ihdr(10, 10), actl(201), fctl(0, 10, 10), idat(10, 10),
  ...Array.from({ length: 200 }, (_, n) => [fctl(1 + 2 * n, 1000, 1000), fdat(2 + 2 * n, 4, 4)]).flat(),
  IEND,
]);
const ATTACKS: [string, Buffer][] = [
  ['a second IHDR', SECOND_IHDR],
  ['an animated PNG with a huge frame', HUGE_FRAME],
  ['an animated PNG with many frames', MANY_FRAMES],
];

/* Real photos, 32x24: baseline and progressive JPEG as a phone or a canvas writes them. */
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABQODxIPDRQSEBIXFRQYHjIhHhwcHj0sLiQySUBMS0dARkVQWnNiUFVtVkVGZIhlbXd7gYKBTmCNl4x9lnN+gXz/2wBDARUXFx4aHjshITt8U0ZTfHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHz/wAARCAAYACADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwClRRRXObBRRRQAUUUUAFFFFAH/2Q==',
  'base64',
);
const PROGRESSIVE_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABQODxIPDRQSEBIXFRQYHjIhHhwcHj0sLiQySUBMS0dARkVQWnNiUFVtVkVGZIhlbXd7gYKBTmCNl4x9lnN+gXz/2wBDARUXFx4aHjshITt8U0ZTfHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHz/wgARCAAYACADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAP/xAAWAQEBAQAAAAAAAAAAAAAAAAAAAgP/2gAMAwEAAhADEAAAAYDOwAAP/8QAFBABAAAAAAAAAAAAAAAAAAAAMP/aAAgBAQABBQJP/8QAFBEBAAAAAAAAAAAAAAAAAAAAIP/aAAgBAwEBPwEf/8QAFBEBAAAAAAAAAAAAAAAAAAAAIP/aAAgBAgEBPwEf/8QAFBABAAAAAAAAAAAAAAAAAAAAMP/aAAgBAQAGPwJP/8QAFBABAAAAAAAAAAAAAAAAAAAAMP/aAAgBAQABPyFP/9oADAMBAAIAAwAAABDzzzz/xAAUEQEAAAAAAAAAAAAAAAAAAAAg/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAg/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAw/9oACAEBAAE/EE//2Q==',
  'base64',
);
/** A JPEG segment: marker, then a length that counts itself. */
const segment = (marker: number, data: number[] | Buffer) => {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([head, Buffer.from(data)]);
};
/** A frame header naming a size: precision 8, three components. */
const sof = (marker: number, width: number, height: number) => {
  const data = Buffer.from([8, 0, 0, 0, 0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  data.writeUInt16BE(height, 1);
  data.writeUInt16BE(width, 3);
  return segment(marker, data);
};
/** Where the real photo's own frame header starts (FF C0 or FF C2). */
const frameAt = (jpeg: Buffer) => jpeg.findIndex((byte, at) => byte === 0xff && (jpeg[at + 1] === 0xc0 || jpeg[at + 1] === 0xc2));
const insertAt = (jpeg: Buffer, at: number, extra: Buffer) => Buffer.concat([jpeg.subarray(0, at), extra, jpeg.subarray(at)]);
const SOS_AT = (jpeg: Buffer) => jpeg.lastIndexOf(Buffer.from([0xff, 0xda]));

const dataUrl = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`;
const SIGNATURE = dataUrl(png(300, 100));
const today = () => new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 10);

async function newInspection(items = ['Sink and taps']) {
  await db.query(`delete from deposit_deduction where finding_id in
    (select f.id from inspection_finding f join inspection i on i.id = f.inspection_id where i.lease_id = $1)`, [LEASE]);
  await db.query(`delete from inspection where lease_id = $1`, [LEASE]);
  const [row] = await db.query<{ id: string }>(
    `insert into inspection (lease_id, kind, scheduled_for) values ($1, 'incoming', $2) returning id`,
    [LEASE, today()],
  );
  expect((await call('PUT', `/inspections/${row!.id}/findings`, OWNER, {
    findings: items.map((item) => ({ room: 'Kitchen', item, condition: 'good' })),
  })).status).toBe(200);
  return row!.id;
}
const render = async (id: string) => {
  const result = await call('POST', `/inspections/${id}/render`, OWNER);
  expect(result.status).toBe(200);
  return result.body.sha256 as string;
};
const sign = (id: string, party: 'landlord' | 'tenant', pdfSha256: string, signatureBase64 = SIGNATURE) =>
  call('POST', `/inspections/${id}/signature`, party === 'landlord' ? OWNER : TENANT, { party, signatureBase64, pdfSha256 });

async function newTicket() {
  const [row] = await db.query<{ id: string }>(
    `insert into ticket (lease_id, category, severity, title, description, target_by, created_by)
     values ($1, 'plumbing', 'routine', 'Dripping tap', 'It drips.', now() + interval '7 days', 'sub-tenant') returning id`,
    [LEASE],
  );
  return row!.id;
}
const seedUnit = async () =>
  (await db.query<{ id: string }>(
    `select u.id from unit u join property p on p.id = u.property_id where p.landlord_id = $1 limit 1`,
    [SEED_LANDLORD],
  ))[0]!.id;

/** Presign, put the bytes where the link points, confirm. */
async function upload(scope: 'inspection' | 'ticket' | 'unit', bytes: Buffer, contentType = 'image/png') {
  let presign: { status: number; body: any };
  let as = TENANT;
  if (scope === 'inspection') {
    presign = await call('POST', `/inspections/${await newInspection()}/photos/presign`, TENANT, {
      room: 'Kitchen', item: 'Sink and taps', contentType, sizeBytes: bytes.length,
    });
  } else if (scope === 'ticket') {
    presign = await call('POST', `/tickets/${await newTicket()}/photos/presign`, TENANT, { phase: 'report', contentType, sizeBytes: bytes.length });
  } else {
    as = OWNER;
    presign = await call('POST', `/units/${await seedUnit()}/photos`, OWNER, { contentType, sizeBytes: bytes.length });
  }
  expect(presign.status).toBe(201);
  await storage.storage().put(presign.body.key, bytes, contentType);
  return call('POST', '/photos/confirm', as, { scope, photoId: presign.body.photoId });
}

describe('1: a crafted PNG cannot reach the decoder', () => {
  it.each(ATTACKS)('the gates refuse %s', (_name, bytes) => {
    // To a reader of the first header alone, each is a 10x10 PNG.
    expect(images.imageDimensions(bytes)).toEqual({ width: 10, height: 10 });
    expect(images.isWellFormedPng(bytes)).toBe(false);
    expect(images.pngBytesFromDataUrl(dataUrl(bytes))).toBeNull();
    expect(images.isPngDataUrl(dataUrl(bytes))).toBe(false);
  });

  it.each(ATTACKS)('the PDF embed path leaves out %s, as a photo and as a signature', async (_name, bytes) => {
    const started = Date.now();
    expect(await pdf.isEmbeddableImage(bytes, 'png')).toBe(false);
    const rendered = await pdf.renderInspectionPdf({
      ref: 'INS-1', kind: 'incoming', unitLabel: 'Unit 1', date: '2026-01-01',
      findings: [{ room: 'Kitchen', item: 'Sink', condition: 'good', photos: [{ bytes, type: 'png' }] }],
      signatures: [{ party: 'tenant', name: 'T', signedAt: '2026-01-01', png: bytes }],
    });
    expect(rendered.bytes.length).toBeGreaterThan(500);
    // Nothing was decoded: the huge frame alone took 23 seconds.
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it.each(ATTACKS)('photo confirm refuses %s on an inspection, a ticket and a unit', async (_name, bytes) => {
    for (const scope of ['inspection', 'ticket', 'unit'] as const) {
      expect((await upload(scope, bytes)).status).toBe(400);
    }
    expect(await db.query(`select 1 from inspection_photo where uploaded union all select 1 from ticket_photo where uploaded`)).toHaveLength(0);
  });

  it.each(ATTACKS)('an inspection signature refuses %s', async (_name, bytes) => {
    const id = await newInspection();
    const sha = await render(id);
    expect((await sign(id, 'tenant', sha, dataUrl(bytes))).status).toBe(400);
    expect(await db.query('select 1 from inspection_signature where inspection_id = $1', [id])).toHaveLength(0);
  });

  it('refuses chunks it does not know, an IHDR of the wrong length, and chunks that run past the file', () => {
    expect(images.isWellFormedPng(png(10, 10, [chunk('zzZz', Buffer.alloc(4))]))).toBe(false);
    expect(images.isWellFormedPng(png(10, 10, [fctl(0, 10, 10)]))).toBe(false);
    expect(images.isWellFormedPng(png(10, 10, [actl(1)]))).toBe(false);
    expect(images.isWellFormedPng(png(10, 10, [fdat(0, 10, 10)]))).toBe(false);
    const longIhdr = Buffer.alloc(14);
    longIhdr.writeUInt32BE(10, 0);
    longIhdr.writeUInt32BE(10, 4);
    longIhdr[8] = 8;
    expect(images.isWellFormedPng(Buffer.concat([PNG_MAGIC, chunk('IHDR', longIhdr), idat(10, 10), IEND]))).toBe(false);
    // A text chunk that claims more bytes than the file has.
    const overrun = chunk('tEXt', Buffer.from('a\0b'));
    overrun.writeUInt32BE(5000, 0);
    expect(images.isWellFormedPng(Buffer.concat([PNG_MAGIC, ihdr(10, 10), overrun, idat(10, 10), IEND]))).toBe(false);
    // IHDR must be first.
    expect(images.isWellFormedPng(Buffer.concat([PNG_MAGIC, chunk('tEXt', Buffer.from('a\0b')), ihdr(10, 10), idat(10, 10), IEND]))).toBe(false);
  });

  it('still passes an ordinary PNG, with the extra chunks writers add', async () => {
    const plain = png(300, 100);
    const withExtras = png(300, 100, [
      chunk('sRGB', Buffer.from([0])), chunk('pHYs', Buffer.alloc(9)), chunk('tEXt', Buffer.from('Software\0phone')), chunk('iDOT', Buffer.alloc(28)),
    ]);
    for (const bytes of [plain, withExtras]) {
      expect(images.isWellFormedPng(bytes)).toBe(true);
      expect(images.pngBytesFromDataUrl(dataUrl(bytes))).not.toBeNull();
      expect(await pdf.isEmbeddableImage(bytes, 'png')).toBe(true);
    }
    for (const scope of ['inspection', 'ticket', 'unit'] as const) {
      expect((await upload(scope, png(1600, 1200))).status).toBe(200);
    }
    const id = await newInspection();
    expect((await sign(id, 'tenant', await render(id))).status).toBe(200);
  }, 60_000);

  it('still passes an ordinary JPEG, baseline or progressive', async () => {
    for (const bytes of [JPEG, PROGRESSIVE_JPEG]) {
      expect(images.imageDimensions(bytes)).toEqual({ width: 32, height: 24 });
      expect(images.isWellFormedJpeg(bytes)).toBe(true);
      expect(await pdf.isEmbeddableImage(bytes, 'jpg')).toBe(true);
      for (const scope of ['inspection', 'ticket', 'unit'] as const) {
        expect((await upload(scope, bytes, 'image/jpeg')).status).toBe(200);
      }
    }
    // Phones add blocks before the frame (EXIF with its own thumbnail) and data after the end.
    const thumbnail = segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0'), sof(0xc0, 60000, 60000)]));
    const dressed = Buffer.concat([insertAt(JPEG, 2, thumbnail), sof(0xc0, 60000, 60000)]);
    expect(images.imageDimensions(dressed)).toEqual({ width: 32, height: 24 });
    expect(await pdf.isEmbeddableImage(dressed, 'jpg')).toBe(true);
  });

  it('refuses a JPEG whose size could be read two ways', async () => {
    const at = frameAt(JPEG);
    const crafted: [string, Buffer][] = [
      // A second frame header: one reader takes the first, another the last.
      ['two frames, small first', insertAt(JPEG, at, sof(0xc0, 8, 8))],
      ['two frames, huge second', insertAt(JPEG, SOS_AT(JPEG), sof(0xc0, 60000, 60000))],
      // pdf-lib takes C8 and CC for frame headers; a decoder does not.
      ['a JPG extension block read as a frame', insertAt(JPEG, at, sof(0xc8, 60000, 60000))],
      ['an arithmetic table read as a frame', insertAt(JPEG, at, sof(0xcc, 60000, 60000))],
      // Fill bytes and bare markers throw pdf-lib's reader off the segment boundaries.
      ['fill bytes before a block', insertAt(JPEG, at, Buffer.from([0xff]))],
      ['a bare marker before the frame', insertAt(JPEG, at, Buffer.from([0xff, 0xd0]))],
      // The line count set after the scan instead of in the frame.
      ['a DNL block', insertAt(JPEG, JPEG.length - 2, segment(0xdc, [0xea, 0x60]))],
      ['a frame header between scans', insertAt(PROGRESSIVE_JPEG, PROGRESSIVE_JPEG.length - 2, sof(0xc2, 60000, 60000))],
      ['lossless coding', Buffer.concat([JPEG.subarray(0, at), sof(0xc3, 32, 24), JPEG.subarray(at + 19)])],
      ['a block that runs past the file', Buffer.concat([JPEG.subarray(0, at), Buffer.from([0xff, 0xe0, 0xff, 0xff])])],
      ['no image data at all', JPEG.subarray(0, SOS_AT(JPEG))],
    ];
    for (const [name, bytes] of crafted) {
      expect(await pdf.isEmbeddableImage(bytes, 'jpg'), name).toBe(false);
      expect(images.isWellFormedJpeg(bytes), name).toBe(false);
    }
    // Hundreds of scans cost a viewer time for nothing.
    const scan = JPEG.subarray(SOS_AT(JPEG), JPEG.length - 2);
    const manyScans = Buffer.concat([JPEG.subarray(0, JPEG.length - 2), ...Array.from({ length: 300 }, () => scan), Buffer.from([0xff, 0xd9])]);
    expect(images.isWellFormedJpeg(manyScans)).toBe(false);
    expect((await upload('ticket', insertAt(JPEG, at, sof(0xc8, 60000, 60000)), 'image/jpeg')).status).toBe(400);
    expect((await upload('unit', insertAt(JPEG, SOS_AT(JPEG), sof(0xc0, 60000, 60000)), 'image/jpeg')).status).toBe(400);
  });
});

describe('2: a report holds only so many decoded pixels', () => {
  it('refuses a new photo larger than the app ever sends', async () => {
    // 4 megapixels: 62 KB on disk, 16 MB decoded. The app redraws to 1600 px.
    expect((await upload('inspection', png(2000, 2000))).status).toBe(400);
    expect((await upload('ticket', png(2000, 2000))).status).toBe(400);
    expect((await upload('inspection', png(1600, 1600))).status).toBe(200);
  }, 60_000);

  it('renders and seals an inspection that already holds too many large photos, and says how many were left out', async () => {
    const items = ['Sink', 'Stove', 'Taps', 'Tiles'];
    const id = await newInspection(items);
    // Twelve photos of 4 megapixels, stored before the ceiling: 48 against a budget of 40.
    const big = png(4000, 1000);
    const findings = await db.query<{ id: string }>('select id from inspection_finding where inspection_id = $1 order by item', [id]);
    let n = 0;
    for (const finding of findings) {
      for (let k = 0; k < 3; k += 1) {
        const key = `inspections/${id}/old-${(n += 1)}.kept.png`;
        await storage.storage().put(key, big, 'image/png');
        await db.query(
          `insert into inspection_photo (finding_id, s3_key, content_type, size_bytes, uploaded) values ($1, $2, 'image/png', $3, true)`,
          [finding.id, key, big.length],
        );
      }
    }
    const { collectReportFindings } = await import('../handlers/inspections-sign');
    const collected = await collectReportFindings(id);
    const kept = collected.findings.flatMap((finding) => finding.photos ?? []);
    expect(kept.reduce((sum, photo) => sum + images.decodedPixels(photo.bytes), 0)).toBeLessThanOrEqual(images.REPORT_PIXEL_BUDGET);
    expect(kept).toHaveLength(10);
    expect(collected.photosOmitted).toBe(2);

    const sha = await render(id);
    expect((await sign(id, 'landlord', sha)).status).toBe(200);
    const sealed = await sign(id, 'tenant', sha);
    expect(sealed.status).toBe(200);
    expect(sealed.body.status).toBe('completed');
  }, 120_000);

  it('does not count JPEGs, which are copied in without decoding', () => {
    expect(images.decodedPixels(JPEG)).toBe(0);
    expect(images.decodedPixels(png(100, 50))).toBe(5000);
  });

  it('holds the same budget for any document, whoever built its photo list', async () => {
    // The exit statement embeds comparison photos straight from its own list.
    const big = { bytes: png(4000, 4000), type: 'png' as const };
    const row = { room: 'Kitchen', item: 'Sink', incomingCondition: 'good', outgoingCondition: 'damaged', incomingPhoto: big, outgoingPhoto: big };
    const rendered = await pdf.renderExitStatementPdf({
      ref: 'TRM-1', leaseRef: 'LSE-1', landlordName: 'L', tenantName: 'T', unitLabel: 'U', leaseEndOn: '2026-01-01', reason: 'end_of_term',
      depositCents: 1, interestCents: 0, arrearsCents: 0, penaltyCents: 0, deductions: [], refundCents: 1, tenantOwesCents: 0,
      refundRule: 'no_deductions', refundDueBy: '2026-01-08', comparisons: Array.from({ length: 6 }, () => row),
    } as never);
    // Twelve 16-megapixel photos were 770 MB held at once; two fit the budget.
    const { PDFDocument, PDFName, PDFRawStream } = await import('pdf-lib');
    const loaded = await PDFDocument.load(rendered.bytes);
    const pictures = loaded.context.enumerateIndirectObjects()
      .filter(([, object]) => object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'));
    expect(pictures).toHaveLength(2);
  }, 120_000);
});

/* People and tenancies for the privacy findings. */
let personNo = 0;
async function tenancy() {
  personNo += 1;
  const email = `s6-${personNo}@example.co.za`;
  const made = await call('POST', '/auth/register', null, { name: 'Naledi Phiri', email, password: 'long-enough-1', consentVersion: PRIVACY_VERSION });
  expect(made.status).toBe(201);
  const as = { sub: made.body.user.sub as string, groups: 'tenant' };
  const [unit] = await db.query<{ id: string }>(
    `insert into unit (property_id, code, bedrooms, bathrooms, monthly_rent_cents, deposit_cents, status)
     values ($1, $2, 1, 1, 500000, 500000, 'vacant') returning id`,
    [seedProperty, `S6-${personNo}`],
  );
  const applied = await call('POST', '/applications', as, {
    unitId: unit!.id, firstName: 'Naledi', lastName: 'Phiri', idNumber: '9001015009086', phone: '0825551234', email,
    employmentStatus: 'employed', monthlyIncomeCents: 2000000, occupants: 1, preferredMoveIn: '2099-01-01',
    consentVersion: PRIVACY_VERSION,
  });
  expect(applied.status).toBe(201);
  const [lease] = await db.query<{ id: string }>(
    `insert into lease (application_id, unit_id, applicant_id, start_date, end_date, monthly_rent_cents, deposit_cents, status)
     select id, unit_id, applicant_id, '2015-01-01', '2016-01-01', 500000, 500000, 'terminated' from application where id = $1
     returning id`,
    [applied.body.id],
  );
  return { as, email, application: applied.body.id as string, lease: lease!.id };
}

describe("3: erasure takes the person out of the landlord's own free text", () => {
  it('blanks the reasons and scrubs the descriptions and notes on the erased leases and applications', async () => {
    const { as, email, application, lease } = await tenancy();
    const told = `Naledi Phiri has a judgment, call 0825551234 or ${email}`;
    await db.query('update application set decline_reason = $2 where id = $1', [application, told]);
    await db.query(
      `insert into arrears_case (lease_id, opened_on, paused_until, pause_reason, paused_by) values ($1, '2015-03-01', '2015-04-01', $2, 'sub-landlord')`,
      [lease, 'Naledi Phiri lost her job; plan agreed'],
    );
    await db.query(
      `insert into payment_proof (lease_id, target, amount_cents, paid_on, s3_key, content_type, size_bytes, status, submitted_by, reject_reason)
       values ($1, 'deposit', 100, '2015-01-01', $2, 'image/jpeg', 10, 'rejected', $3, $4)`,
      [lease, `proofs/${lease}/slip.jpg`, as.sub, told],
    );
    const [ticket] = await db.query<{ id: string }>(
      `insert into ticket (lease_id, category, severity, title, description, target_by, created_by)
       values ($1, 'plumbing', 'routine', 'Geyser', 'Burst', now(), 'sub-landlord') returning id`,
      [lease],
    );
    await db.query(`insert into ticket_event (ticket_id, actor_role, kind, note) values ($1, 'landlord', 'comment', $2), ($1, 'system', 'comment', $2)`, [ticket!.id, told]);
    await db.query(
      `insert into pending_charge (lease_id, period_start, kind, description, amount_cents, added_by) values ($1, '2015-02-01', 'other', $2, 5000, 'sub-landlord')`,
      [lease, 'Lost key, Naledi Phiri 0825551234'],
    );
    const [invoice] = await db.query<{ id: string }>(
      `insert into invoice (lease_id, period_start, due_on, total_cents) values ($1, '2015-02-01', '2015-02-01', 505000) returning id`,
      [lease],
    );
    await db.query(`insert into invoice_line (invoice_id, kind, description, amount_cents) values ($1, 'other', $2, 5000), ($1, 'rent', 'Rent for February 2015', 500000)`, [invoice!.id, 'Lost key, Naledi Phiri +27825551234']);
    const [termination] = await db.query<{ id: string }>(
      `insert into termination (lease_id, initiated_by, reason, notice_given_on, effective_on, notice_days) values ($1, 'tenant', 'end_of_term', '2015-12-01', '2016-01-01', 31) returning id`,
      [lease],
    );
    await db.query(`insert into deposit_deduction (termination_id, description, amount_cents) values ($1, $2, 90000)`, [termination!.id, 'Carpet burnt by Naledi Phiri']);
    const [inspection] = await db.query<{ id: string }>(`insert into inspection (lease_id, kind, scheduled_for) values ($1, 'outgoing', '2016-01-01') returning id`, [lease]);
    await db.query(`insert into inspection_finding (inspection_id, room, item, condition, note) values ($1, 'Lounge', 'Carpet', 'damaged', $2)`, [inspection!.id, `Burn mark; Naledi Phiri admits it (${email})`]);
    await db.query(
      `insert into deposit_ledger (lease_id, entry_type, amount_cents, note) values ($1, 'deduction', 90000, $2), ($1, 'refund', 410000, $3)`,
      [lease, 'Carpet, agreed with Naledi Phiri', 'Refund paid to Naledi Phiri 0825551234'],
    );

    await privacy.erasePerson(as.sub, { sub: 'sub-landlord', role: 'landlord' }, { landlordId: SEED_LANDLORD });

    const rows = await db.query<{ source: string; text: string | null }>(
      `select 'decline' as source, decline_reason as text from application where id = $1
       union all select 'pause', pause_reason from arrears_case where lease_id = $2
       union all select 'reject', reject_reason from payment_proof where lease_id = $2
       union all select 'event', note from ticket_event where ticket_id = $3
       union all select 'charge', description from pending_charge where lease_id = $2
       union all select 'line', description from invoice_line where invoice_id = $4
       union all select 'deduction', description from deposit_deduction where termination_id = $5
       union all select 'finding', note from inspection_finding where inspection_id = $6
       union all select 'ledger', note from deposit_ledger where lease_id = $2`,
      [application, lease, ticket!.id, invoice!.id, termination!.id, inspection!.id],
    );
    expect(rows).toHaveLength(12);
    for (const row of rows) {
      expect(row.text, row.source).not.toMatch(/Naledi|Phiri|0825551234|\+27825551234|example\.co\.za/);
    }
    const text = (source: string) => rows.filter((row) => row.source === source).map((row) => row.text);
    // Reasons go whole; the rows stay valid (a pause and a rejection each need a reason).
    expect(text('decline')).toEqual(['[erased]']);
    expect(text('pause')).toEqual(['[erased]']);
    expect(text('reject')).toEqual(['[erased]']);
    // What the statements and the repair history need keeps its meaning.
    expect(text('deduction')).toEqual(['Carpet burnt by the tenant']);
    expect(text('charge')).toEqual(['Lost key, the tenant [phone removed]']);
    expect(text('line').sort()).toEqual(['Lost key, the tenant [phone removed]', 'Rent for February 2015']);
    expect(text('ledger').sort()).toEqual(['Carpet, agreed with the tenant', 'Refund paid to the tenant [phone removed]']);
    expect(text('finding')).toEqual(['Burn mark; the tenant admits it ([email removed])']);
  });

  it("leaves another tenant's rows alone", async () => {
    const erased = await tenancy();
    const other = await tenancy();
    await db.query(`insert into pending_charge (lease_id, period_start, kind, description, amount_cents, added_by) values ($1, '2015-02-01', 'other', 'Key for Naledi Phiri', 5000, 'sub-landlord')`, [other.lease]);
    await db.query('update application set decline_reason = $2 where id = $1', [other.application, 'Income too low']);
    await privacy.erasePerson(erased.as.sub, { sub: 'sub-landlord', role: 'landlord' }, { landlordId: SEED_LANDLORD });
    expect((await db.query<{ description: string }>('select description from pending_charge where lease_id = $1', [other.lease]))[0]!.description).toBe('Key for Naledi Phiri');
    expect((await db.query<{ decline_reason: string }>('select decline_reason from application where id = $1', [other.application]))[0]!.decline_reason).toBe('Income too low');
  });
});

describe('5: a restore that was never resumed shows on /health', () => {
  it('reports the hold, and turns red once it has lasted more than six hours', async () => {
    process.env.RUN_JOBS = 'false';
    const plain = await call('GET', '/health', null);
    expect(plain.status).toBe(200);
    expect(plain.body.jobsHeldSince).toBeNull();

    process.env.JOBS_HELD_SINCE = new Date(Date.now() - 3_600_000).toISOString();
    const held = await call('GET', '/health', null);
    expect(held.status).toBe(200);
    expect(held.body.jobsHeldSince).toBe(process.env.JOBS_HELD_SINCE);
    expect(held.body.jobsHeldTooLong).toBe(false);

    process.env.JOBS_HELD_SINCE = new Date(Date.now() - 7 * 3_600_000).toISOString();
    const forgotten = await call('GET', '/health', null);
    expect(forgotten.status).toBe(503);
    expect(forgotten.body).toMatchObject({ ok: false, jobsHeldTooLong: true });

    // A value nobody can read is still a hold.
    process.env.JOBS_HELD_SINCE = 'yesterday';
    expect((await call('GET', '/health', null)).status).toBe(503);
  });

  it('has restore.sh stamp the hold with the time it began, and the README say so', () => {
    const restore = readFileSync(join(DEPLOY, 'restore.sh'), 'utf8');
    expect(restore).toMatch(/RUN_JOBS: "false"\n\s+JOBS_HELD_SINCE: "\$\(date -u \+%Y-%m-%dT%H:%M:%SZ\)"/);
    // The heredoc must expand the date, so its marker is not quoted.
    expect(restore).toMatch(/cat > "\$HOLD" <<EOF_HOLD\n/);
    expect(readFileSync(join(DEPLOY, 'README.md'), 'utf8')).toMatch(/held the jobs for over six hours/);
  });
});

describe('6: a double-tapped confirm on the last allowed photo keeps it', () => {
  /** Runs a second confirm of the same photo while the first is still reading the bytes. */
  async function doubleTap(scope: 'ticket' | 'inspection', photoId: string, key: string) {
    const store = storage.storage();
    const realGet = store.get.bind(store);
    let second: Promise<{ status: number; body: any }> | null = null;
    vi.spyOn(store, 'get').mockImplementation(async (wanted: string) => {
      const bytes = await realGet(wanted);
      if (wanted === key && !second) {
        second = call('POST', '/photos/confirm', TENANT, { scope, photoId });
        await second;
      }
      return bytes;
    });
    const first = await call('POST', '/photos/confirm', TENANT, { scope, photoId });
    return { first, second: await second! };
  }

  it('on a ticket at its cap', async () => {
    const ticketId = await newTicket();
    await db.query(
      `insert into ticket_photo (ticket_id, phase, s3_key, content_type, size_bytes, uploaded)
       select $1::uuid, 'report', 'tickets/' || $2 || '/old-' || n || '.kept.jpg', 'image/jpeg', 10, true from generate_series(1, 19) n`,
      [ticketId, ticketId],
    );
    const presign = await call('POST', `/tickets/${ticketId}/photos/presign`, TENANT, { phase: 'report', contentType: 'image/jpeg', sizeBytes: JPEG.length });
    expect(presign.status).toBe(201);
    await storage.storage().put(presign.body.key, JPEG, 'image/jpeg');
    const { first, second } = await doubleTap('ticket', presign.body.photoId, presign.body.key);
    expect(second.status).toBe(200);
    expect(first.status).toBe(200);
    const [row] = await db.query<{ uploaded: boolean; s3_key: string }>('select uploaded, s3_key from ticket_photo where id = $1', [presign.body.photoId]);
    expect(row?.uploaded).toBe(true);
    expect(await storage.storage().sizeOf(row!.s3_key)).toBe(JPEG.length);
  });

  it('on an inspection finding at its cap', async () => {
    const id = await newInspection();
    const [finding] = await db.query<{ id: string }>('select id from inspection_finding where inspection_id = $1', [id]);
    await db.query(
      `insert into inspection_photo (finding_id, s3_key, content_type, size_bytes, uploaded)
       select $1::uuid, 'inspections/' || $2 || '/gone-' || n || '.kept.jpg', 'image/jpeg', 10, true from generate_series(1, 5) n`,
      [finding!.id, id],
    );
    const presign = await call('POST', `/inspections/${id}/photos/presign`, TENANT, {
      room: 'Kitchen', item: 'Sink and taps', contentType: 'image/jpeg', sizeBytes: JPEG.length,
    });
    expect(presign.status).toBe(201);
    await storage.storage().put(presign.body.key, JPEG, 'image/jpeg');
    const { first, second } = await doubleTap('inspection', presign.body.photoId, presign.body.key);
    expect(second.status).toBe(200);
    expect(first.status).toBe(200);
    const [row] = await db.query<{ uploaded: boolean; s3_key: string }>('select uploaded, s3_key from inspection_photo where id = $1', [presign.body.photoId]);
    expect(row?.uploaded).toBe(true);
    expect(await storage.storage().sizeOf(row!.s3_key)).toBe(JPEG.length);
  });
});

describe('7: malformed input is a 400 or a 404, not a 500', () => {
  it('answers 400 to a two-step body that is not JSON, or not an object', async () => {
    const made = await call('POST', '/auth/register', null, { name: 'Two Step', email: 's6-two-step@example.co.za', password: 'long-enough-1', consentVersion: PRIVACY_VERSION });
    expect(made.status).toBe(201);
    const as = { sub: made.body.user.sub as string, groups: 'tenant' };
    expect((await call('POST', '/auth/two-step', as, undefined, '{not json')).status).toBe(400);
    expect((await call('POST', '/auth/two-step', as, undefined, 'null')).status).toBe(400);
    expect((await call('POST', '/auth/two-step', as, undefined, '{"action":7}')).status).toBe(400);
    // The real thing still works.
    expect((await call('POST', '/auth/two-step', as, { action: 'setup', password: 'long-enough-1' })).status).toBe(200);
  });

  it('answers 404 to a path with a broken escape, as for any id that names no record', async () => {
    const { match } = await import('../router');
    expect(() => match('GET', '/leases/%E0%A4%A')).not.toThrow();
    const broken = await call('GET', '/leases/%E0%A4%A', OWNER);
    expect(broken.status).toBe(404);
    expect(broken.body).toEqual((await call('GET', '/leases/not-a-uuid', OWNER)).body);
    expect((await call('DELETE', `/units/${await seedUnit()}/photos/%ZZ`, OWNER)).status).toBe(404);
  });
});

describe('9: an erasure request whose person is already gone can still be closed', () => {
  it('completes instead of answering 404 for good', async () => {
    const { as } = await tenancy();
    const [request] = await db.query<{ id: string }>(
      `insert into privacy_request (person_sub, note, landlord_id) values ($1, 'I am Naledi Phiri, please erase me', $2) returning id`,
      [as.sub, SEED_LANDLORD],
    );
    // The erasure went through, and the update that marks the request did not.
    const erased = await privacy.erasePerson(as.sub, { sub: 'sub-landlord', role: 'landlord' }, { landlordId: SEED_LANDLORD });
    expect(erased.identityErased).toBe(true);
    expect((await db.query<{ status: string }>('select status from privacy_request where id = $1', [request!.id]))[0]!.status).toBe('pending');

    const retry = await call('POST', `/privacy-requests/${request!.id}/decision`, OWNER, { decision: 'erase' });
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe('completed');
    const [row] = await db.query<{ status: string; note: string | null; decided_by: string }>('select status, note, decided_by from privacy_request where id = $1', [request!.id]);
    expect(row).toEqual({ status: 'completed', note: null, decided_by: 'sub-landlord' });
    // Answered once.
    expect((await call('POST', `/privacy-requests/${request!.id}/decision`, OWNER, { decision: 'erase' })).status).toBe(409);
  });

  it("still hides another landlord's request", async () => {
    const { as } = await tenancy();
    const [other] = await db.query<{ id: string }>(
      `insert into landlord (trading_name, email, phone, cognito_sub) values ('Other Lets', 'o6@example.co.za', '0820000000', 'sub-landlord-six') returning id`,
    );
    const [request] = await db.query<{ id: string }>(`insert into privacy_request (person_sub, landlord_id) values ($1, $2) returning id`, [as.sub, other!.id]);
    await privacy.erasePerson(as.sub, { sub: 'sub-landlord', role: 'landlord' }, { landlordId: SEED_LANDLORD });
    expect((await call('POST', `/privacy-requests/${request!.id}/decision`, OWNER, { decision: 'erase' })).status).toBe(404);
  });
});

/* Last: this one loads a second copy of the storage module, with the S3 driver. */
describe('8: an upload link on AWS takes only the size that was declared', () => {
  it('has every upload handler pass the declared size to the link', () => {
    const calls = readdirSync(HANDLERS)
      .filter((name) => name.endsWith('.ts'))
      .flatMap((name) => [...readFileSync(join(HANDLERS, name), 'utf8').matchAll(/presignPut\(([^)]*)\)/g)].map((found) => `${name}: ${found[1]}`));
    expect(calls.length).toBeGreaterThanOrEqual(6);
    for (const args of calls) expect(args).toMatch(/, 300, input\.(slip\.)?sizeBytes$/);
  });

  it('hands the size to the storage driver, and the self-hosted link still works without it', async () => {
    const spy = vi.spyOn(storage.storage(), 'presignPut');
    const presign = await call('POST', `/tickets/${await newTicket()}/photos/presign`, TENANT, { phase: 'report', contentType: 'image/jpeg', sizeBytes: 4321 });
    expect(presign.status).toBe(201);
    expect(spy).toHaveBeenCalledWith(expect.any(String), 'image/jpeg', 300, 4321);
    expect(presign.body.uploadUrl).toMatch(/\/files\/tickets\/.*\?exp=\d+&sig=[0-9a-f]+$/);
  });

  it('signs Content-Length into the S3 link, and no checksum of an empty body', async () => {
    const saved = { driver: process.env.STORAGE_DRIVER, id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY };
    vi.resetModules();
    delete process.env.STORAGE_DRIVER;
    process.env.AWS_ACCESS_KEY_ID = 'AKIAEXAMPLEEXAMPLE';
    process.env.AWS_SECRET_ACCESS_KEY = 'example';
    try {
      const s3 = (await import('../lib/storage')).storage();
      const link = new URL(await s3.presignPut('units/u/p.jpg', 'image/jpeg', 300, 4321));
      expect(link.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;host');
      expect(link.searchParams.get('X-Amz-Expires')).toBe('300');
      expect([...link.searchParams.keys()].filter((key) => key.toLowerCase().includes('checksum'))).toEqual([]);
      // A link made without a size (nothing in the app does this now) is as before.
      const open = new URL(await s3.presignPut('units/u/p.jpg', 'image/jpeg', 300));
      expect(open.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    } finally {
      process.env.STORAGE_DRIVER = saved.driver;
      if (saved.id === undefined) delete process.env.AWS_ACCESS_KEY_ID; else process.env.AWS_ACCESS_KEY_ID = saved.id;
      if (saved.secret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY; else process.env.AWS_SECRET_ACCESS_KEY = saved.secret;
      vi.resetModules();
    }
  });
});
