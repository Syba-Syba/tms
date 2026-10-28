import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { stat } from 'node:fs/promises';
import { query } from '../lib/db';
import { JOBS } from '../lib/scheduler';

const BACKUP_STALE_HOURS = 36;

const reply = (status: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode: status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
});

/**
 * For an uptime monitor and the container's health check: 200 when the database answers, every
 * daily job has finished in the last two days and (hosted) the last backup is under 36 hours
 * old; 503 otherwise, saying which.
 * No sign-in, and nothing in it about any landlord or tenant.
 */
export const handler = async (): Promise<APIGatewayProxyResultV2> => {
  const version = process.env.APP_VERSION ?? 'dev';
  try {
    await query('select 1');
  } catch {
    return reply(503, { ok: false, version, database: 'down' });
  }
  const runs = await query<{ job: string; at: string }>(
    `select detail->>'job' as job, max(at)::text as at from audit_log
      where action = 'job.finished' and at > now() - interval '2 days'
      group by detail->>'job'`,
  );
  const lastRun = Object.fromEntries(runs.map((row) => [row.job, row.at]));
  // A job that only runs on one day of the month cannot be judged on a two-day window.
  const daily = JOBS.filter((job) => job.dailyAt && !job.onDay).map((job) => job.name);
  const behind = process.env.RUN_JOBS === 'false' || process.env.HEALTH_SKIP_JOBS === 'true' ? [] : daily.filter((name) => !lastRun[name]);

  // With BACKUP_MARKER set (the hosted kit), a backup older than 36 hours turns this red too.
  let backup: string | null = null;
  let backupStale = false;
  if (process.env.BACKUP_MARKER) {
    try {
      const { mtime } = await stat(process.env.BACKUP_MARKER);
      backup = mtime.toISOString();
      backupStale = Date.now() - mtime.getTime() > BACKUP_STALE_HOURS * 3_600_000;
    } catch {
      backupStale = true;
    }
  }
  const ok = behind.length === 0 && !backupStale;
  return reply(ok ? 200 : 503, { ok, version, database: 'ok', jobsBehind: behind, lastRun, backup, backupStale });
};
