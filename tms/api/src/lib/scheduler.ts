import { handler as invoicesRun } from '../handlers/invoices-run';
import { handler as interestRun } from '../handlers/interest-run';
import { handler as leasesActivate } from '../handlers/leases-activate';
import { handler as notificationsDispatch } from '../handlers/notifications-dispatch';
import { handler as notificationsSweep } from '../handlers/notifications-sweep';
import { sastToday } from '../domain/dates';
import { logger } from './logger';

/**
 * The five jobs EventBridge runs in the AWS deployment, run from inside the self-hosted
 * process instead. Without this a self-hosted install never issued an invoice, never credited
 * deposit interest, never activated a renewal and never sent a notification: the handlers
 * existed, and nothing called them.
 *
 * Every job is idempotent (unique keys on invoices, interest months and notification dedupe
 * keys; status guards on activation), so each daily job also runs once at startup. A machine
 * that was off at 06:00 catches up when it comes back rather than skipping the month.
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
  { name: 'notifications-sweep', run: notificationsSweep, dailyAt: '05:00' },
  { name: 'interest-run', run: interestRun, dailyAt: '05:30', onDay: 1 },
  { name: 'invoices-run', run: () => invoicesRun(), dailyAt: '06:00' },
];

const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;
const sastClock = (now: Date) => new Date(now.getTime() + SAST_OFFSET_MS).toISOString().slice(11, 16);

export async function runJob(name: string): Promise<unknown> {
  const job = JOBS.find((candidate) => candidate.name === name);
  if (!job) throw new Error(`No job named "${name}". Jobs: ${JOBS.map((j) => j.name).join(', ')}.`);
  return job.run();
}

export function startScheduler(options: { tickMs?: number; now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  const lastRun = new Map<string, number>();
  const lastDay = new Map<string, string>();
  const inFlight = new Set<string>();

  const fire = async (job: Job, why: string) => {
    if (inFlight.has(job.name)) return;
    inFlight.add(job.name);
    const started = Date.now();
    try {
      const result = await job.run();
      logger.info('Job finished.', { job: job.name, why, durationMs: Date.now() - started, result });
    } catch (error) {
      // One failing job must not take the scheduler, or the server, down with it.
      logger.error('Job failed.', { job: job.name, why, error });
    } finally {
      inFlight.delete(job.name);
      lastRun.set(job.name, Date.now());
      lastDay.set(job.name, sastToday(now()));
    }
  };

  const tick = async () => {
    const current = now();
    const today = sastToday(current);
    const clock = sastClock(current);
    for (const job of JOBS) {
      if (job.everyMinutes) {
        const previous = lastRun.get(job.name) ?? 0;
        if (Date.now() - previous >= job.everyMinutes * 60_000) await fire(job, 'interval');
        continue;
      }
      if (job.dailyAt && clock >= job.dailyAt && lastDay.get(job.name) !== today) {
        if (job.onDay && Number(today.slice(8, 10)) !== job.onDay) continue;
        await fire(job, `daily at ${job.dailyAt}`);
      }
    }
  };

  // Catch-up: the daily jobs run once on boot, in dependency order (activation before
  // invoicing). Interest is monthly and idempotent per month, so it runs too.
  const catchUp = async () => {
    for (const job of JOBS) {
      if (job.dailyAt) await fire(job, 'startup catch-up');
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
