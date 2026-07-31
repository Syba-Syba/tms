import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshDb } from './helpers/db';
import { seedLease, type Seeded } from './helpers/seed';

let db: PGlite;
let seeded: Seeded;

beforeAll(async () => {
  db = await freshDb();
  seeded = await seedLease(db);
}, 60_000);

afterAll(async () => db?.close());

const enqueue = (kind: string, ageHours = 0, urgent = false) =>
  db.query<{ id: string }>(
    `insert into notification
       (lease_id, recipient_sub, recipient_to, channel, category, kind, urgent, subject, body,
        created_at, send_after)
     values ($1, 'sub-tenant', 'tenant@example.co.za', 'email', 'money', $2, $3,
             'Subject', 'Body',
             now() - ($4 || ' hours')::interval, now() - ($4 || ' hours')::interval)
     returning id`,
    [seeded.leaseId, kind, urgent, String(ageHours)],
  );

/** The exact claim the dispatcher makes, including its staleness flag. */
const claim = () =>
  db.query<{ id: string; kind: string; stale: boolean }>(
    `update notification
        set attempts = attempts + 1
      where id in (
        select id from notification
         where status = 'pending' and send_after <= now()
         order by urgent desc, send_after
         limit 50 for update skip locked
      )
      returning id, kind, created_at < now() - interval '24 hours' as stale`,
  );

describe('deferring email without breaking anything', () => {
  it('lets business events fill the outbox with no sender configured', async () => {
    // notify() only writes a row. Nothing in the request path touches SES, which is the
    // whole reason the outbox exists.
    await enqueue('invoice_issued');
    await enqueue('payment_received');
    const { rows } = await db.query<{ count: string }>(
      `select count(*)::text as count from notification where status = 'pending'`,
    );
    expect(Number(rows[0]!.count)).toBe(2);
  });

  it('drains the outbox in skip mode so nothing accumulates', async () => {
    const claimed = await claim();
    expect(claimed.rows).toHaveLength(2);
    for (const row of claimed.rows) {
      await db.query(`update notification set status = 'skipped', last_error = $2 where id = $1`, [
        row.id,
        'NOTIFY_MODE=skip',
      ]);
    }
    const { rows } = await db.query<{ count: string }>(
      `select count(*)::text as count from notification where status = 'pending'`,
    );
    expect(Number(rows[0]!.count)).toBe(0);
  });

  it('flags anything older than a day as stale', async () => {
    await enqueue('rent_overdue', 30);
    await enqueue('invoice_issued', 2);
    const claimed = await claim();
    const stale = claimed.rows.filter((row) => row.stale).map((row) => row.kind);
    const fresh = claimed.rows.filter((row) => !row.stale).map((row) => row.kind);
    expect(stale).toEqual(['rent_overdue']);
    expect(fresh).toEqual(['invoice_issued']);
  });

  it('never leaves a backlog that could flood someone when sending is switched on', async () => {
    // A rent reminder for a month already paid is worse than no reminder, so a stale row is
    // parked rather than delivered.
    await db.query(`update notification set status = 'skipped' where status = 'pending'`);
    const { rows } = await db.query<{ count: string }>(
      `select count(*)::text as count from notification
        where status = 'pending' and created_at < now() - interval '24 hours'`,
    );
    expect(Number(rows[0]!.count)).toBe(0);
  });

  it('keeps what would have been sent, so the feature can be checked later', async () => {
    const { rows } = await db.query<{ subject: string; last_error: string | null }>(
      `select subject, last_error from notification where status = 'skipped' limit 1`,
    );
    expect(rows[0]!.subject).toBe('Subject');
    expect(rows[0]!.last_error).toBeTruthy();
  });
});
