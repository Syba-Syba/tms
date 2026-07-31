import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshDb } from './helpers/db';
import { seedLease, type Seeded } from './helpers/seed';

let db: PGlite;
let seeded: Seeded;
let terminationId: string;

const RANK: Record<string, number> = { good: 0, fair: 1, poor: 2, damaged: 3, missing: 4 };

beforeAll(async () => {
  db = await freshDb();
  seeded = await seedLease(db);

  const incoming = await db.query<{ id: string }>(
    `insert into inspection (lease_id, kind, status, scheduled_for)
     values ($1, 'incoming', 'completed', '2026-08-30') returning id`,
    [seeded.leaseId],
  );
  const outgoing = await db.query<{ id: string }>(
    `insert into inspection (lease_id, kind, status, scheduled_for)
     values ($1, 'outgoing', 'completed', '2027-08-29') returning id`,
    [seeded.leaseId],
  );
  await db.query(
    `insert into inspection_finding (inspection_id, room, item, condition) values
       ($1, 'Kitchen', 'Stove', 'good'), ($1, 'Kitchen', 'Sink', 'good'),
       ($1, 'Lounge', 'Flooring', 'good'), ($1, 'Bathroom', 'Geyser', 'fair')`,
    [incoming.rows[0]!.id],
  );
  await db.query(
    `insert into inspection_finding (inspection_id, room, item, condition, note) values
       ($1, 'Kitchen', 'Stove', 'damaged', 'Element burnt out'),
       ($1, 'Kitchen', 'Sink', 'good', null),
       ($1, 'Lounge', 'Flooring', 'fair', null),
       ($1, 'Garden', 'Gate', 'damaged', 'Hinge gone')`,
    [outgoing.rows[0]!.id],
  );
  const termination = await db.query<{ id: string }>(
    `insert into termination (lease_id, initiated_by, reason, notice_given_on, effective_on, notice_days)
     values ($1, 'tenant', 'end_of_term', '2027-07-01', '2027-08-31', 0) returning id`,
    [seeded.leaseId],
  );
  terminationId = termination.rows[0]!.id;
}, 60_000);

afterAll(async () => db?.close());

async function comparison() {
  const { rows } = await db.query<{
    room: string;
    item: string;
    incoming_condition: string | null;
    outgoing_condition: string | null;
  }>(
    `with insp as (
       select i.kind, f.id, f.room, f.item, f.condition, f.note
         from termination t
         join inspection i on i.lease_id = t.lease_id
         join inspection_finding f on f.inspection_id = i.id
        where t.id = $1
     )
     select coalesce(inc.room, out.room) as room,
            coalesce(inc.item, out.item) as item,
            inc.condition as incoming_condition,
            out.condition as outgoing_condition
       from (select * from insp where kind = 'incoming') inc
       full outer join (select * from insp where kind = 'outgoing') out
         on out.room = inc.room and out.item = inc.item
      order by 1, 2`,
    [terminationId],
  );
  return rows.map((row) => {
    const noBaseline = row.incoming_condition === null;
    const notReinspected = row.outgoing_condition === null;
    const worsenedBy =
      noBaseline || notReinspected
        ? 0
        : (RANK[row.outgoing_condition!] ?? 0) - (RANK[row.incoming_condition!] ?? 0);
    return {
      key: `${row.room}/${row.item}`,
      noBaseline,
      notReinspected,
      worsenedBy,
      deductible: !noBaseline && !notReinspected && worsenedBy >= 2,
    };
  });
}

describe('incoming versus outgoing comparison', () => {
  it('pairs every item across both inspections', async () => {
    const items = await comparison();
    expect(items.map((item) => item.key)).toEqual([
      'Bathroom/Geyser',
      'Garden/Gate',
      'Kitchen/Sink',
      'Kitchen/Stove',
      'Lounge/Flooring',
    ]);
  });

  it('offers a deduction where an item dropped two steps', async () => {
    const stove = (await comparison()).find((item) => item.key === 'Kitchen/Stove')!;
    expect(stove.worsenedBy).toBe(3);
    expect(stove.deductible).toBe(true);
  });

  it('treats one step down as fair wear, not damage', async () => {
    const flooring = (await comparison()).find((item) => item.key === 'Lounge/Flooring')!;
    expect(flooring.worsenedBy).toBe(1);
    expect(flooring.deductible).toBe(false);
  });

  it('refuses to charge for an item the move-in inspection never recorded', async () => {
    // Presuming an unrecorded item started in good condition lets a landlord charge for
    // damage that may predate the tenant.
    const gate = (await comparison()).find((item) => item.key === 'Garden/Gate')!;
    expect(gate.noBaseline).toBe(true);
    expect(gate.deductible).toBe(false);
  });

  it('flags an item the exit inspection skipped instead of calling it improved', async () => {
    const geyser = (await comparison()).find((item) => item.key === 'Bathroom/Geyser')!;
    expect(geyser.notReinspected).toBe(true);
    expect(geyser.worsenedBy).toBe(0);
  });
});

describe('statement evidence', () => {
  it('shows every charged item, including one with no move-in record', async () => {
    const { rows } = await db.query<{ room: string; item: string; incoming_condition: string }>(
      `with insp as (
         select i.kind, f.id, f.room, f.item, f.condition, f.note
           from inspection i join inspection_finding f on f.inspection_id = i.id
          where i.lease_id = $1
       )
       select out.room, out.item, coalesce(inc.condition, 'not recorded') as incoming_condition
         from (select * from insp where kind = 'outgoing') out
         left join (select * from insp where kind = 'incoming') inc
           on out.room = inc.room and out.item = inc.item
        where out.condition in ('poor', 'damaged', 'missing')
          and (inc.condition is null or out.condition <> inc.condition)
        order by out.room, out.item`,
      [seeded.leaseId],
    );
    // The old inner join silently dropped the gate, so the statement charged without showing why.
    expect(rows.map((row) => `${row.room}/${row.item}`)).toEqual(['Garden/Gate', 'Kitchen/Stove']);
    expect(rows.find((row) => row.item === 'Gate')!.incoming_condition).toBe('not recorded');
  });
});
