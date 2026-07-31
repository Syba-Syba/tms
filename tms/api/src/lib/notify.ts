import type { PoolClient } from 'pg';
import { query } from './db';
import { render, sendAfter, type Category, type Channel } from '../domain/notification';

type Run = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

export interface Recipient {
  sub: string;
  email?: string | null;
  phone?: string | null;
}

export interface NotifyInput {
  leaseId?: string | null;
  to: Recipient;
  kind: string;
  data: Record<string, string>;
  /** Present for anything a sweep can raise twice. Sending it once is the whole point. */
  dedupeKey?: string;
  at?: Date;
}

const CHANNEL_FIELD: Record<Channel, keyof Recipient> = {
  email: 'email',
  whatsapp: 'phone',
  push: 'sub',
};

/**
 * Queue a notification. Pass the transaction's `run` so the row lands in the same commit as the
 * event that caused it: no message about a rollback, no lost message on a crash.
 */
export async function notify(input: NotifyInput, run?: Run): Promise<void> {
  const execute: Run = run ?? ((sql, params) => query(sql, params) as Promise<never[]>);
  const at = input.at ?? new Date();
  const { category, urgent, subject, body } = render(input.kind, input.data);

  const enabled = await execute<{ channel: Channel; enabled: boolean }>(
    `select channel, enabled from notification_preference
      where person_sub = $1 and category = $2`,
    [input.to.sub, category],
  );
  const off = new Set(enabled.filter((row) => !row.enabled).map((row) => row.channel));

  // Email is the default channel because it is the one address we always hold.
  const channels: Channel[] = ['email'];
  if (input.to.phone) channels.push('whatsapp');

  for (const channel of channels) {
    if (off.has(channel) && category !== 'deadline') continue;
    const destination = input.to[CHANNEL_FIELD[channel]];
    if (!destination) continue;

    await execute(
      `insert into notification
         (lease_id, recipient_sub, recipient_to, channel, category, kind, urgent,
          subject, body, dedupe_key, send_after)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (dedupe_key) where dedupe_key is not null do nothing`,
      [
        input.leaseId ?? null,
        input.to.sub,
        destination,
        channel,
        category,
        input.kind,
        urgent,
        subject,
        body,
        input.dedupeKey ? `${input.dedupeKey}:${channel}` : null,
        sendAfter(at, urgent),
      ],
    );
  }
}

/** Convenience for handlers already holding a pg client inside withTransaction. */
export const runner = (client: PoolClient): Run =>
  async <T>(sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows as T[];

export type { Category };
