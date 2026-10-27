import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const LEASE = '66666666-6666-6666-6666-666666666666';

/**
 * The real queue (lib/notify) and the real dispatcher, not copies of their SQL. Dispatch runs
 * in smtp mode with no SMTP_URL, so every email send fails without touching a network: that is
 * what exercises the retry and the attempt ceiling.
 */
let db: typeof import('../lib/db');
let notify: typeof import('../lib/notify').notify;
let dispatch: typeof import('../handlers/notifications-dispatch').handler;
const saved = { mode: process.env.NOTIFY_MODE, smtp: process.env.SMTP_URL };

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://notification-outbox-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'tms-storage-'));
  process.env.KMS_DRIVER = 'local';
  process.env.NOTIFY_MODE = 'smtp';
  delete process.env.SMTP_URL;

  db = await import('../lib/db');
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  for (const file of all.filter((n) => !n.includes('seed'))) await db.execScript(read(file));
  for (const file of all.filter((n) => n.includes('seed'))) await db.execScript(read(file));
  ({ notify } = await import('../lib/notify'));
  ({ handler: dispatch } = await import('../handlers/notifications-dispatch'));
}, 120_000);

afterAll(() => {
  if (saved.mode === undefined) delete process.env.NOTIFY_MODE;
  else process.env.NOTIFY_MODE = saved.mode;
  if (saved.smtp !== undefined) process.env.SMTP_URL = saved.smtp;
});

const overdue = (dedupeKey?: string) =>
  notify({
    leaseId: LEASE,
    to: { sub: 'sub-tenant', email: 'tenant@example.co.za' },
    kind: 'rent_overdue',
    dedupeKey,
    data: {
      period: 'October 2026', amount: 'R 8 500.00', dueOn: '2026-10-01',
      daysLate: '3', reference: 'LSE-00001', unit: 'Kruis Court A1',
    },
  });

/** A row ready to send now, with a channel and an urgency the test chooses. */
const queued = async (fields: { kind?: string; urgent?: boolean; channel?: string; attempts?: number; sendAfter?: string } = {}) => {
  const [row] = await db.query<{ id: string }>(
    `insert into notification
       (lease_id, recipient_sub, recipient_to, channel, category, kind, urgent, subject, body, attempts, send_after)
     values ($1, 'sub-tenant', 'tenant@example.co.za', $2, 'money', $3, $4, 's', 'b', $5, coalesce($6::timestamptz, now()))
     returning id`,
    [LEASE, fields.channel ?? 'email', fields.kind ?? 'invoice_issued', fields.urgent ?? false,
     fields.attempts ?? 0, fields.sendAfter ?? null],
  );
  return row!.id;
};

const state = async (id: string) =>
  (await db.query<{ status: string; attempts: number; last_error: string | null; waits: boolean }>(
    `select status, attempts, last_error, send_after > now() as waits from notification where id = $1`,
    [id],
  ))[0]!;

const clear = () => db.query('delete from notification');

describe('notification outbox', () => {
  it('queues a deduped message only once no matter how often the sweep runs', async () => {
    for (let run = 0; run < 4; run += 1) await overdue('rent_overdue:inv-1:2026-10-04');
    const rows = await db.query(`select id from notification where dedupe_key like 'rent_overdue:inv-1:%'`);
    expect(rows).toHaveLength(1);
  });

  it('still allows repeats where no dedupe key is given', async () => {
    await clear();
    await overdue();
    await overdue();
    expect(await db.query('select id from notification')).toHaveLength(2);
  });

  it('claims the urgent message ahead of a full batch already waiting', async () => {
    await clear();
    const waiting: string[] = [];
    for (let n = 0; n < 50; n += 1) waiting.push(await queued({ sendAfter: '2026-01-01T00:00:00Z' }));
    const urgent = await queued({ kind: 'ticket_raised', urgent: true });

    const result = await dispatch();

    expect(result.claimed).toBe(50);
    expect((await state(urgent)).attempts).toBe(1);
    const untouched = await db.query(`select id from notification where attempts = 0`);
    expect(untouched).toHaveLength(1);
  });

  it('retries a failed send later, then fails it at the attempt ceiling', async () => {
    await clear();
    const id = await queued();
    await dispatch();
    expect(await state(id)).toMatchObject({ status: 'pending', attempts: 1, waits: true });
    expect((await state(id)).last_error).toMatch(/SMTP_URL/);

    await db.query(`update notification set attempts = 4, send_after = now() where id = $1`, [id]);
    await dispatch();
    expect(await state(id)).toMatchObject({ status: 'failed', attempts: 5 });
  });

  it('parks a channel that has no sender rather than retrying it forever', async () => {
    await clear();
    const id = await queued({ channel: 'whatsapp' });
    await dispatch();
    expect(await state(id)).toMatchObject({ status: 'skipped', attempts: 1 });
  });

  it('holds a queued message until its send_after time', async () => {
    await clear();
    const id = await queued({ sendAfter: new Date(Date.now() + 6 * 3600_000).toISOString() });
    expect((await dispatch()).claimed).toBe(0);
    expect(await state(id)).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('drops a message that has gone stale instead of delivering old news', async () => {
    await clear();
    const id = await queued();
    await db.query(`update notification set created_at = now() - interval '25 hours' where id = $1`, [id]);
    await dispatch();
    expect(await state(id)).toMatchObject({ status: 'skipped', last_error: 'older than 24h, not sent' });
  });
});
