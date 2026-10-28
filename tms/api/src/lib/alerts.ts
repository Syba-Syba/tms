import { logger } from './logger';

/** One alert per kind of failure per hour: a broken database fails every request at once. */
const QUIET_MS = 60 * 60_000;
const lastSent = new Map<string, number>();

/**
 * Emails ALERT_EMAIL, the person running the service, about something that needs a human: an
 * unhandled error, a scheduled job that failed. Never throws, and does nothing when ALERT_EMAIL
 * is unset.
 */
export async function alert(key: string, subject: string, detail: string): Promise<void> {
  const to = process.env.ALERT_EMAIL;
  if (!to) return;
  const now = Date.now();
  const previous = lastSent.get(key);
  if (previous !== undefined && now - previous < QUIET_MS) return;
  lastSent.set(key, now);
  try {
    const { sendDirectEmail } = await import('../handlers/notifications-dispatch');
    await sendDirectEmail(
      to,
      `[Threshold] ${subject}`,
      `${detail}\n\nServer time ${new Date(now).toISOString()}. More of the same is held back for an hour; the logs have every one.`,
    );
  } catch (error) {
    logger.error('Alert could not be sent.', { key, error });
  }
}

/** For tests. */
export const resetAlerts = () => lastSent.clear();

export const describeError = (error: unknown) =>
  error instanceof Error ? `${error.message}\n\n${error.stack ?? ''}`.slice(0, 4000) : String(error).slice(0, 4000);
