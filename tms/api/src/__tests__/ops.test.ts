import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sent: { to: string; subject: string; body: string }[] = [];
vi.mock('../handlers/notifications-dispatch', () => ({
  handler: async () => ({}),
  sendDirectEmail: async (to: string, subject: string, body: string) => {
    sent.push({ to, subject, body });
  },
}));

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
let db: typeof import('../lib/db');

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://ops-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  db = await import('../lib/db');
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  for (const file of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql') && !n.includes('seed')).sort()) {
    await db.execScript(read(file));
  }
}, 120_000);

describe('the health check', () => {
  it('names the daily jobs that have not finished in two days, then reports healthy', async () => {
    const { handler } = await import('../handlers/health');
    const before = (await handler()) as { statusCode: number; body: string };
    expect(before.statusCode).toBe(503);
    const behind = JSON.parse(before.body).jobsBehind as string[];
    expect(behind).toContain('invoices-run');
    // Interest runs daily now (catching up a missed 1st), so it is judged like the others.
    expect(behind).toContain('interest-run');

    for (const job of behind) {
      await db.query(`insert into audit_log (actor_role, action, entity, detail) values ('job', 'job.finished', 'job', $1)`, [
        JSON.stringify({ job }),
      ]);
    }
    const after = (await handler()) as { statusCode: number; body: string };
    expect(after.statusCode).toBe(200);
    expect(JSON.parse(after.body)).toMatchObject({ ok: true, database: 'ok', jobsBehind: [] });
  });

  it('turns red when the last backup is missing or over 36 hours old', async () => {
    const { handler } = await import('../handlers/health');
    const { mkdtempSync, writeFileSync, utimesSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const marker = join(mkdtempSync(join(tmpdir(), 'tms-backup-')), 'last-ok');
    process.env.BACKUP_MARKER = marker;
    expect(JSON.parse(((await handler()) as { body: string }).body)).toMatchObject({ ok: false, backupStale: true });
    writeFileSync(marker, 'x');
    expect(((await handler()) as { statusCode: number }).statusCode).toBe(200);
    const old = new Date(Date.now() - 40 * 3_600_000);
    utimesSync(marker, old, old);
    expect(((await handler()) as { statusCode: number }).statusCode).toBe(503);
    delete process.env.BACKUP_MARKER;
  });
});

describe('alerts', () => {
  it('email the operator once an hour per kind of failure, and never when unset', async () => {
    const { alert, resetAlerts } = await import('../lib/alerts');
    resetAlerts();
    delete process.env.ALERT_EMAIL;
    await alert('job:invoices-run', 'Scheduled job invoices-run failed', 'boom');
    expect(sent).toHaveLength(0);

    process.env.ALERT_EMAIL = 'ops@example.co.za';
    await alert('job:invoices-run', 'Scheduled job invoices-run failed', 'boom');
    await alert('job:invoices-run', 'Scheduled job invoices-run failed', 'boom again');
    await alert('request:GET /leases', 'Error on GET /leases', 'db down');
    expect(sent.map((mail) => mail.subject)).toEqual([
      '[Threshold] Scheduled job invoices-run failed',
      '[Threshold] Error on GET /leases',
    ]);
    expect(sent[0]!.to).toBe('ops@example.co.za');
    delete process.env.ALERT_EMAIL;
  });

  it('go out when a request fails unexpectedly', async () => {
    const { resetAlerts } = await import('../lib/alerts');
    resetAlerts();
    sent.length = 0;
    process.env.ALERT_EMAIL = 'ops@example.co.za';
    const { route } = await import('../lib/http');
    const failing = route(async () => {
      throw new Error('relation "lease" does not exist');
    });
    const result = (await failing({
      rawPath: '/leases',
      requestContext: { http: { method: 'GET', path: '/leases', sourceIp: '1.1.1.1', userAgent: 't' } },
    } as never)) as { statusCode: number };
    expect(result.statusCode).toBe(500);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent[0]).toMatchObject({ subject: '[Threshold] Error on GET /leases' });
    expect(sent[0]!.body).toContain('relation "lease" does not exist');
    delete process.env.ALERT_EMAIL;
  });
});
