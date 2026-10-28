import { handler as invoicesRun } from '../handlers/invoices-run';
import { handler as interestRun } from '../handlers/interest-run';
import { handler as leasesActivate } from '../handlers/leases-activate';
import { handler as notificationsDispatch } from '../handlers/notifications-dispatch';
import { handler as notificationsSweep } from '../handlers/notifications-sweep';
import { handler as privacySweep } from '../handlers/privacy-sweep';
import { handler as arrearsRun } from '../handlers/arrears-run';
import { sastToday } from '../domain/dates';
import { audit } from './audit';
import { logger } from './logger';

/**
 * The jobs EventBridge runs in the AWS deployment, run from inside the self-hosted
 * process instead. Without this a self-hosted install never issued an invoice, never credited
 * deposit interest, never activated a renewal and never sent a notification: the handlers
 * existed, and nothing called them.
 *
 * Every job is idempotent (unique keys on invoices, interest months and notification dedupe
 * keys; status guards on activation), so each daily job also runs once at startup. A machine
 * that was off at 06:00 catches up when it comes back rather than skipping the month. A job
 * with onDay catches up only on that day: interest posted on the 15th credited a month to a
 * deposit that arrived on the 10th, and only because the server happened to restart.
 *
 * A day counts as done only when the job succeeded. A failed run is retried on later ticks,
 * with a growing wait, rather than waiting for tomorrow (or, for interest, next month).
 */
export interface Job {
  name: string;
  run: () => Promise<unknown>;
  /** Minutes between runs, for the dispatcher. */
  everyMinutes?: number;
  /** 'HH:MM' in Johannesburg, once a day. */
  dailyAt?: string;
  /** Only on this day of the month, with dailyAt. */
  onDay?: number;
}

export const JOBS: Job[] = [
  { name: 'notifications-dispatch', run: notificationsDispatch, everyMinutes: 5 },
  { name: 'leases-activate', run: leasesActivate, dailyAt: '03:10' },
  { name: 'privacy-sweep', run: privacySweep, dailyAt: '04:30' },
  { name: 'notifications-sweep', run: notificationsSweep, dailyAt: '05:00' },
  { name: 'arrears-run', run: () => arrearsRun(), dailyAt: '05:15' },
  { name: 'interest-run', run: interestRun, dailyAt: '05:30', onDay: 1 },
  { name: 'invoices-run', run: () => invoicesRun(), dailyAt: '06:00' },
];

const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;
const sastClock = (now: Date) => new Date(now.getTime() + SAST_OFFSET_MS).toISOString().slice(11, 16);

/** Minutes to wait before retrying a failed daily job: 15, 30, 60, then every 2 hours. */
export const retryDelayMinutes = (failures: number) => Math.min(15 * 2 ** (failures - 1), 120);

/** A finished daily job is a state change like any other, so it goes in the audit log. */
const recordRun = async (job: Job, why: string, result: unknown) => {
  try {
    await audit({
      actorSub: 'system',
      actorRole: 'system',
      action: 'job.finished',
      entity: 'job',
      entityId: null,
      detail: { job: job.name, why, result: result ?? null },
    });
  } catch (error) {
    // The job did its work. Failing it now would only run it again.
    logger.error('Job finished but its audit row was not written.', { job: job.name, error });
  }
};

export async function runJob(name: string): Promise<unknown> {
  const job = JOBS.find((candidate) => candidate.name === name);
  if (!job) throw new Error(`No job named "${name}". Jobs: ${JOBS.map((j) => j.name).join(', ')}.`);
  const result = await job.run();
  if (job.dailyAt) await recordRun(job, 'by hand', result);
  return result;
}

export function startScheduler(
  options: { tickMs?: number; now?: () => Date; jobs?: Job[] } = {},
) {
  const now = options.now ?? (() => new Date());
  const jobs = options.jobs ?? JOBS;
  const lastRun = new Map<string, number>();
  /** The SAST day each daily job last succeeded on. */
  const lastDay = new Map<string, string>();
  /** Failures today, and when the last one was, for the retry wait. */
  const failures = new Map<string, { day: string; count: number; at: number }>();
  const inFlight = new Set<string>();

  /** True when the job ran and succeeded. */
  const fire = async (job: Job, why: string): Promise<boolean> => {
    if (inFlight.has(job.name)) return false;
    inFlight.add(job.name);
    const started = Date.now();
    try {
      const result = await job.run();
      failures.delete(job.name);
      logger.info('Job finished.', { job: job.name, why, durationMs: Date.now() - started, result });
      if (job.dailyAt) await recordRun(job, why, result);
      return true;
    } catch (error) {
      // One failing job must not take the scheduler, or the server, down with it.
      const today = sastToday(now());
      const previous = failures.get(job.name);
      const count = previous?.day === today ? previous.count + 1 : 1;
      failures.set(job.name, { day: today, count, at: now().getTime() });
      logger.error('Job failed.', { job: job.name, why, error, failuresToday: count });
      return false;
    } finally {
      inFlight.delete(job.name);
      lastRun.set(job.name, Date.now());
    }
  };

  /** A daily job is due once its day, and its time, have come, unless it already succeeded
      today or is still waiting out a retry. */
  const dailyDue = (job: Job, current: Date) => {
    const today = sastToday(current);
    if (lastDay.get(job.name) === today) return false;
    if (job.onDay && Number(today.slice(8, 10)) !== job.onDay) return false;
    const failed = failures.get(job.name);
    if (failed?.day === today && current.getTime() - failed.at < retryDelayMinutes(failed.count) * 60_000) {
      return false;
    }
    return true;
  };

  const tick = async () => {
    const current = now();
    const clock = sastClock(current);
    for (const job of jobs) {
      if (job.everyMinutes) {
        const previous = lastRun.get(job.name) ?? 0;
        if (Date.now() - previous >= job.everyMinutes * 60_000) await fire(job, 'interval');
        continue;
      }
      if (job.dailyAt && clock >= job.dailyAt && dailyDue(job, current)) {
        if (await fire(job, `daily at ${job.dailyAt}`)) lastDay.set(job.name, sastToday(current));
      }
    }
  };

  // Catch-up: the daily jobs run once on boot, in dependency order (activation before
  // invoicing). Interest runs only on the 1st, as it would have on its own tick. Before a
  // job's own time, a catch-up is yesterday's missed run arriving late (the sweep still dates
  // by UTC before 02:00), so the job runs again at its time today rather than being skipped.
  const catchUp = async () => {
    for (const job of jobs) {
      const current = now();
      if (!job.dailyAt || !dailyDue(job, current)) continue;
      const ok = await fire(job, 'startup catch-up');
      if (ok && sastClock(current) >= job.dailyAt) lastDay.set(job.name, sastToday(current));
    }
  };
  const timer = setInterval(() => void tick(), options.tickMs ?? 60_000);
  timer.unref();
  const boot = setTimeout(() => void catchUp(), 5_000);
  boot.unref();

  return {
    stop: () => {
      clearInterval(timer);
      clearTimeout(boot);
    },
    tick,
    catchUp,
  };
}
