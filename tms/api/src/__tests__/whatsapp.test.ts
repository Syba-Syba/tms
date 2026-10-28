import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flatten, MAX_PARAMETER, waNumber } from '../lib/whatsapp';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

describe('the WhatsApp message', () => {
  it('fits a template parameter: one line, no long gaps, under the limit', () => {
    expect(flatten('Rent due', 'R 8 500,00 for Kruis Court A1.\n\nPay by EFT with LSE-00101.\tThanks')).toBe(
      'Rent due. R 8 500,00 for Kruis Court A1. Pay by EFT with LSE-00101. Thanks',
    );
    const long = flatten('Subject', 'x'.repeat(2000));
    expect(long.length).toBe(MAX_PARAMETER);
    expect(long.endsWith('…')).toBe(true);
    expect(waNumber('+27 82 123 4567')).toBe('27821234567');
  });
});

let db: typeof import('../lib/db');
let dispatch: () => Promise<Record<string, unknown>>;
const fetchMock = vi.fn();

const queue = async (to: string) => {
  const [row] = await db.query<{ id: string }>(
    `insert into notification (recipient_sub, recipient_to, channel, category, kind, urgent, subject, body)
     values ('sub-tenant', $1, 'whatsapp', 'money', 'rent_due', true, 'Rent due', 'Pay R 8 500,00.\nThanks') returning id`,
    [to],
  );
  return row!.id;
};
const statusOf = async (id: string) =>
  (await db.query<{ status: string; last_error: string | null }>('select status, last_error from notification where id = $1', [id]))[0]!;

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://whatsapp-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.NOTIFY_MODE = 'send';
  process.env.WHATSAPP_TOKEN = 'test-token';
  process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';
  process.env.WHATSAPP_TEMPLATE = 'threshold_update';
  vi.stubGlobal('fetch', fetchMock);

  db = await import('../lib/db');
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  for (const file of all.filter((n) => !n.includes('seed'))) await db.execScript(read(file));
  ({ handler: dispatch } = await import('../handlers/notifications-dispatch'));
}, 120_000);

afterAll(() => {
  vi.unstubAllGlobals();
  for (const key of ['NOTIFY_MODE', 'WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_TEMPLATE']) delete process.env[key];
});

describe('sending through the Cloud API', () => {
  it('sends the approved template with the message as its parameter', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] }), { status: 200 }));
    const id = await queue('+27821234567');
    await dispatch();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://graph.facebook.com/v23.0/1234567890/messages');
    expect(init.headers.authorization).toBe('Bearer test-token');
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: 'whatsapp',
      to: '27821234567',
      type: 'template',
      template: {
        name: 'threshold_update',
        language: { code: 'en' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: 'Rent due. Pay R 8 500,00. Thanks' }] }],
      },
    });
    expect((await statusOf(id)).status).toBe('sent');
  });

  it('parks a number that is not on WhatsApp, and retries a server error', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 131026, message: 'Message undeliverable' } }), { status: 400 }),
    );
    const gone = await queue('+27820000000');
    await dispatch();
    expect(await statusOf(gone)).toEqual({ status: 'skipped', last_error: 'WhatsApp 400: Message undeliverable' });

    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 503 }));
    const later = await queue('+27821111111');
    await dispatch();
    expect((await statusOf(later)).status).toBe('pending');
  });
});
