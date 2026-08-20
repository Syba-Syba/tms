import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { query } from '../lib/db';
import { env } from '../lib/env';
import { jobLogger } from '../lib/logger';

const log = jobLogger('notifications-dispatch');

/** Enough of an address to recognise the row in a log, not enough to be the address. */
const maskRecipient = (to: string) => {
  const at = to.indexOf('@');
  if (at > 0) return `${to.slice(0, 1)}***${to.slice(at)}`;
  return to.length > 4 ? `***${to.slice(-4)}` : '***';
};

const ses = new SESv2Client({ region: env.AWS_REGION });

const FROM = process.env.NOTIFY_FROM ?? 'no-reply@example.invalid';
const MAX_ATTEMPTS = 5;
const BATCH = 50;

/**
 * 'skip' drains the outbox without sending anything, logging what each message would have been.
 * That is the default, so a fresh deploy cannot email a real tenant from an unverified address
 * or pile up failures against a domain that does not exist yet. Set NOTIFY_MODE=send once the
 * sending domain is verified and out of the SES sandbox.
 */
const MODE = process.env.NOTIFY_MODE === 'send' ? 'send' : 'skip';

/**
 * A notification is worth sending while it is still news. Left pending long enough, it becomes
 * misleading: a rent reminder for a month already paid is worse than no reminder at all. So
 * anything older than this is dropped rather than delivered, which also means switching sending
 * on later cannot flood anyone with a backlog.
 */
const STALE_AFTER_HOURS = 24;

interface Pending {
  id: string;
  channel: string;
  recipient_to: string;
  subject: string;
  body: string;
  attempts: number;
  stale: boolean;
}

async function deliver(row: Pending): Promise<void> {
  if (row.channel === 'email') {
    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: FROM,
        Destination: { ToAddresses: [row.recipient_to] },
        Content: {
          Simple: {
            Subject: { Data: row.subject, Charset: 'UTF-8' },
            Body: { Text: { Data: row.body, Charset: 'UTF-8' } },
          },
        },
      }),
    );
    return;
  }
  // WhatsApp and push are modelled but not connected. Failing them would retry forever, so
  // they are parked and stay visible in the table for when a sender exists.
  throw Object.assign(new Error(`Channel ${row.channel} is not connected yet.`), { skip: true });
}

const park = (id: string, reason: string) =>
  query(`update notification set status = 'skipped', last_error = $2 where id = $1`, [id, reason]);

/** Runs every few minutes. Claims a batch, then sends or parks each row on its own merits. */
export const handler = async () => {
  const due = await query<Pending>(
    `update notification
        set attempts = attempts + 1
      where id in (
        select id from notification
         where status = 'pending' and send_after <= now()
         order by urgent desc, send_after
         limit ${BATCH}
         for update skip locked
      )
      returning id, channel, recipient_to, subject, body, attempts,
                created_at < now() - interval '${STALE_AFTER_HOURS} hours' as stale`,
  );

  const counts = { claimed: due.length, sent: 0, failed: 0, skipped: 0, stale: 0 };

  for (const row of due) {
    if (row.stale) {
      await park(row.id, `older than ${STALE_AFTER_HOURS}h, not sent`);
      counts.stale += 1;
      continue;
    }

    if (MODE === 'skip') {
      // Logged rather than sent, so the whole pipeline can be verified before a domain exists.
      // The address is masked: skip mode is the default, so this runs in deployed stages too,
      // and a log group is not the place for a tenant's email address or phone number.
      log.info('Notification not sent, NOTIFY_MODE=skip.', {
        notificationId: row.id,
        to: maskRecipient(row.recipient_to),
        channel: row.channel,
        subject: row.subject,
      });
      await park(row.id, 'NOTIFY_MODE=skip');
      counts.skipped += 1;
      continue;
    }

    try {
      await deliver(row);
      await query(`update notification set status = 'sent', sent_at = now() where id = $1`, [row.id]);
      counts.sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const parked = (error as { skip?: boolean }).skip === true;
      const exhausted = row.attempts >= MAX_ATTEMPTS;
      await query(`update notification set status = $2, last_error = $3 where id = $1`, [
        row.id,
        parked ? 'skipped' : exhausted ? 'failed' : 'pending',
        message.slice(0, 500),
      ]);
      if (parked) counts.skipped += 1;
      else counts.failed += 1;
    }
  }

  log.info('Notification dispatch complete.', { mode: MODE, ...counts });
  return { mode: MODE, ...counts };
};
