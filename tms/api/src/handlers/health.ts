import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { stat } from 'node:fs/promises';
import { query } from '../lib/db';
import { JOBS } from '../lib/scheduler';

const BACKUP_STALE_HOURS = 36;
/** Long enough to check a restore by hand; past it the resume has been forgotten. */
const JOBS_HOLD_HOURS = 6;

const reply = (status: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode: status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
});

/**
 * For an uptime monitor and the container's health check: 200 when the database answers, every
 * daily job has finished in the last two days and (hosted) the last backup is under 36 hours
 * old; 503 otherwise, saying which. Also 503 once a restore has held the jobs and the outbox
 * (restore.sh sets JOBS_HELD_SINCE) for more than six hours: nothing is "behind" while they are
 * off, so a forgotten `./restore.sh resume` stopped invoices and every email with health green.
 * No sign-in, and nothing in it about any landlord or tenant.
 */
/**
 * The last run of each job. entity = 'job' (scheduler.ts writes it) lets audit_log_entity_idx
 * serve this: without it every call, open to anyone, read the whole activity log.
 */
export const JOB_RUNS_SQL = `select detail->>'job' as job, max(at)::text as at from audit_log
  where entity = 'job' and entity_id is null and action = 'job.finished' and at > now() - interval '2 days'
  group by detail->>'job'`;

export const handler = async (): Promise<APIGatewayProxyResultV2> => {
  const version = process.env.APP_VERSION ?? 'dev';
  try {
    await query('select 1');
  } catch {
    return reply(503, { ok: false, version, database: 'down' });
  }
  const runs = await query<{ job: string; at: string }>(JOB_RUNS_SQL);
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
  const jobsHeldSince = process.env.JOBS_HELD_SINCE || null;
  // A date that cannot be read counts as too long ago: the hold is real either way.
  const heldFor = jobsHeldSince ? Date.now() - Date.parse(jobsHeldSince) : 0;
  const jobsHeldTooLong = jobsHeldSince !== null && !(heldFor <= JOBS_HOLD_HOURS * 3_600_000);
  const ok = behind.length === 0 && !backupStale && !jobsHeldTooLong;
  return reply(ok ? 200 : 503, {
    ok, version, database: 'ok', jobsBehind: behind, lastRun, backup, backupStale, jobsHeldSince, jobsHeldTooLong,
  });
};
