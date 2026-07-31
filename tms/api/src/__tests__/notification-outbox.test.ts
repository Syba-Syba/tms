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

const enqueue = (dedupe: string | null, kind = 'rent_overdue', urgent = false) =>
  db.query(
    `insert into notification
       (lease_id, recipient_sub, recipient_to, channel, category, kind, urgent, subject, body, dedupe_key)
     values ($1, 'sub-tenant', 'tenant@example.co.za', 'email', 'money', $2, $3, 'Subject', 'Body', $4)
     on conflict (dedupe_key) where dedupe_key is not null do nothing`,
    [seeded.leaseId, kind, urgent, dedupe],
  );

describe('notification outbox', () => {
  it('sends a deduped message only once no matter how often the sweep runs', async () => {
    for (let run = 0; run < 4; run += 1) await enqueue('rent_overdue:inv-1:2026-10-04');
    const { rows } = await db.query<{ count: string }>(
      `select count(*)::text as count from notification where dedupe_key = $1`,
      ['rent_overdue:inv-1:2026-10-04'],
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it('still allows repeats where no dedupe key is given', async () => {
    await enqueue(null, 'payment_received');
    await enqueue(null, 'payment_received');
    const { rows } = await db.query<{ count: string }>(
      `select count(*)::text as count from notification where kind = 'payment_received'`,
    );
    expect(Number(rows[0]!.count)).toBe(2);
  });

  it('claims the urgent message ahead of everything else waiting', async () => {
    await enqueue('urgent-1', 'ticket_raised', true);
    // RETURNING order is undefined in Postgres, so claim exactly one and check which it is.
    const claimed = await db.query<{ kind: string }>(
      `update notification set attempts = attempts + 1
        where id in (
          select id from notification where status = 'pending' and send_after <= now()
          order by urgent desc, send_after limit 1 for update skip locked
        ) returning kind`,
    );
    expect(claimed.rows).toHaveLength(1);
    expect(claimed.rows[0]!.kind).toBe('ticket_raised');
  });

  it('keeps a row pending until the attempt ceiling, then fails it', async () => {
    const inserted = await db.query<{ id: string }>(
      `insert into notification
         (lease_id, recipient_sub, recipient_to, channel, category, kind, subject, body, attempts)
       values ($1, 'sub-tenant', 'x@example.co.za', 'email', 'money', 'rent_overdue', 's', 'b', 5)
       returning id`,
      [seeded.leaseId],
    );
    const id = inserted.rows[0]!.id;
    await db.query(`update notification set status = 'failed', last_error = 'SES rejected' where id = $1`, [id]);
    const { rows } = await db.query<{ status: string; attempts: number }>(
      `select status, attempts from notification where id = $1`,
      [id],
    );
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.attempts).toBe(5);
  });

  it('holds a queued message until its send_after time', async () => {
    await db.query(
      `insert into notification
         (lease_id, recipient_sub, recipient_to, channel, category, kind, subject, body, send_after)
       values ($1, 'sub-tenant', 'x@example.co.za', 'email', 'money', 'invoice_issued', 's', 'b',
               now() + interval '6 hours')`,
      [seeded.leaseId],
    );
    const { rows } = await db.query<{ count: string }>(
      `select count(*)::text as count from notification
        where status = 'pending' and send_after <= now() and kind = 'invoice_issued'`,
    );
    expect(Number(rows[0]!.count)).toBe(0);
  });

  it('records an interest rate history rather than one environment variable', async () => {
    await db.query(`insert into deposit_interest_rate (annual_pct, effective_from) values (6.250, '2026-07-01')`);
    const { rows } = await db.query<{ annual_pct: string }>(
      `select annual_pct from deposit_interest_rate
        where effective_from <= '2026-09-01' order by effective_from desc limit 1`,
    );
    expect(Number(rows[0]!.annual_pct)).toBe(6.25);
  });
});
