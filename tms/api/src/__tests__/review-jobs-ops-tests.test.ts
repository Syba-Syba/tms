import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '../../../db/migrations');
const API = join(HERE, '../..');
const LEASE = '66666666-6666-6666-6666-666666666666';

/** The self-hosted scheduler: when a daily job counts as done, what catch-up may run, and
    the cron entry point refusing to share a PGlite folder with the server. */
type Opts = { sub?: string; groups?: string; body?: unknown };
let call: (method: string, path: string, opts?: Opts) => Promise<{ status: number; body: any }>;
let db: typeof import('../lib/db');
let scheduler: typeof import('../lib/scheduler');
const started: Array<{ stop: () => void }> = [];

beforeAll(async () => {
  process.env.DB_DRIVER = 'pglite';
  process.env.PGLITE_DIR = `memory://review-jobs-${Date.now()}`;
  process.env.NODE_ENV = 'development';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'tms-storage-'));
  process.env.KMS_DRIVER = 'local';

  db = await import('../lib/db');
  const read = (name: string) => readFileSync(join(MIGRATIONS, name), 'utf8');
  const all = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
  for (const file of all.filter((n) => !n.includes('seed'))) await db.execScript(read(file));
  for (const file of all.filter((n) => n.includes('seed'))) await db.execScript(read(file));
  scheduler = await import('../lib/scheduler');

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

afterAll(() => {
  for (const s of started) s.stop();
});

/** A scheduler on a clock the test moves. Times are UTC; SAST is two hours ahead. */
const harness = (jobs: import('../lib/scheduler').Job[], at: string) => {
  const clock = { now: new Date(at) };
  const s = scheduler.startScheduler({ jobs, now: () => clock.now, tickMs: 3_600_000 });
  started.push(s);
  return { ...s, at: (iso: string) => (clock.now = new Date(iso)) };
};

const counter = (fail = 0) => {
  const job = { runs: 0, fail, run: async () => {
    job.runs += 1;
    if (job.fail > 0) {
      job.fail -= 1;
      throw new Error('database unavailable');
    }
    return { ok: true };
  } };
  return job;
};

describe('startup catch-up and deposit interest', () => {
  it('posts no interest when the server restarts mid-month', async () => {
    // The probe: a restart on the 15th credited the whole month to every held deposit.
    const s = harness(scheduler.JOBS, '2026-10-15T08:00:00Z');
    await s.catchUp();
    const rows = await db.query(`select id from deposit_ledger where entry_type = 'interest'`);
    expect(rows).toHaveLength(0);
    // The other daily jobs still caught up, and each left a record.
    const audited = await db.query<{ job: string }>(
      `select detail->>'job' as job from audit_log where action = 'job.finished' order by id`,
    );
    expect(audited.map((row) => row.job)).toEqual(['leases-activate', 'notifications-sweep', 'invoices-run']);
  });

  it('catches up a job with onDay only on that day', async () => {
    const monthly = counter();
    const daily = counter();
    const jobs = [
      { name: 'monthly', run: monthly.run, dailyAt: '05:30', onDay: 1 },
      { name: 'daily', run: daily.run, dailyAt: '06:00' },
    ];
    await harness(jobs, '2026-10-15T08:00:00Z').catchUp();
    expect([monthly.runs, daily.runs]).toEqual([0, 1]);
    await harness(jobs, '2026-11-01T08:00:00Z').catchUp();
    expect([monthly.runs, daily.runs]).toEqual([1, 2]);
    expect(scheduler.JOBS.find((job) => job.name === 'interest-run')?.onDay).toBe(1);
  });
});

describe('a daily job counts as done only when it succeeded', () => {
  it('retries a failed run later the same day, after a wait', async () => {
    const job = counter(1);
    const s = harness([{ name: 'invoices', run: job.run, dailyAt: '06:00' }], '2026-10-25T04:00:00Z');
    await s.tick(); // 06:00 SAST: fails
    expect(job.runs).toBe(1);
    s.at('2026-10-25T04:05:00Z');
    await s.tick(); // still inside the 15 minute wait
    expect(job.runs).toBe(1);
    s.at('2026-10-25T04:16:00Z');
    await s.tick(); // retried, and succeeds
    expect(job.runs).toBe(2);
    s.at('2026-10-25T07:00:00Z');
    await s.tick(); // done for today
    expect(job.runs).toBe(2);
    s.at('2026-10-26T04:00:00Z');
    await s.tick();
    expect(job.runs).toBe(3);
  });

  it('retries a failed interest run on the 1st rather than waiting a month', async () => {
    const job = counter(2);
    const s = harness([{ name: 'interest', run: job.run, dailyAt: '05:30', onDay: 1 }], '2026-11-01T03:30:00Z');
    await s.tick();
    s.at('2026-11-01T03:46:00Z');
    await s.tick(); // second failure; the wait doubles to 30 minutes
    s.at('2026-11-01T04:06:00Z');
    await s.tick();
    expect(job.runs).toBe(2);
    s.at('2026-11-01T04:17:00Z');
    await s.tick();
    expect(job.runs).toBe(3);
    expect(job.fail).toBe(0);
  });

  it('does not mark a failed catch-up as done', async () => {
    const job = counter(1);
    const s = harness([{ name: 'invoices', run: job.run, dailyAt: '06:00' }], '2026-10-25T08:00:00Z');
    await s.catchUp();
    s.at('2026-10-25T08:20:00Z');
    await s.tick();
    expect(job.runs).toBe(2);
  });
});

describe('a catch-up before the job’s own time', () => {
  it('still lets the job run at its time that day', async () => {
    // Booting at 01:00 SAST: the sweep still dates by UTC, so the catch-up is yesterday's run.
    const job = counter();
    const s = harness([{ name: 'sweep', run: job.run, dailyAt: '05:00' }], '2026-10-24T23:00:00Z');
    await s.catchUp();
    s.at('2026-10-25T03:00:00Z');
    await s.tick();
    expect(job.runs).toBe(2);
  });

  it('counts a catch-up after the job’s time as that day’s run', async () => {
    const job = counter();
    const s = harness([{ name: 'sweep', run: job.run, dailyAt: '05:00' }], '2026-10-25T05:00:00Z');
    await s.catchUp();
    s.at('2026-10-25T06:00:00Z');
    await s.tick();
    expect(job.runs).toBe(1);
  });
});

describe('npm run jobs on PGlite', () => {
  it('refuses rather than open the folder the server holds', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'tms-jobs-')), 'pglite');
    const result = spawnSync(join(API, '../../node_modules/.bin/tsx'), ['src/jobs.ts', 'invoices-run'], {
      cwd: API,
      env: { ...process.env, DB_DRIVER: 'pglite', PGLITE_DIR: dir },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/DB_DRIVER=pglite cannot be shared/);
    expect(existsSync(dir)).toBe(false);
  }, 60_000);
});

describe('inspection findings are on the record', () => {
  it('writes who recorded which finding', async () => {
    await db.query(`delete from deposit_deduction where finding_id in
      (select f.id from inspection_finding f join inspection i on i.id = f.inspection_id where i.lease_id = $1)`, [LEASE]);
    await db.query(`delete from inspection where lease_id = $1 and kind = 'incoming'`, [LEASE]);
    const created = await call('POST', `/leases/${LEASE}/inspections`, {
      body: { kind: 'incoming', scheduledFor: new Date().toISOString().slice(0, 10) },
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const finding = { room: 'Kitchen', item: 'Sink and taps', condition: 'damaged', note: 'Tap head snapped' };
    const saved = await call('PUT', `/inspections/${id}/findings`, { body: { findings: [finding] } });
    expect(saved.status).toBe(200);

    const rows = await db.query<{ actor_sub: string; actor_role: string; detail: any }>(
      `select actor_sub, actor_role, detail from audit_log
        where action = 'inspection.findings_saved' and entity_id = $1`,
      [id],
    );
    expect(rows).toEqual([
      { actor_sub: 'sub-landlord', actor_role: 'landlord', detail: { findings: [finding] } },
    ]);
  });
});
