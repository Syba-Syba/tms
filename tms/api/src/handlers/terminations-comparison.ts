import { requireLeaseAccessVia } from '../lib/access';
import { query } from '../lib/db';
import { badRequest, json, route } from '../lib/http';

interface Row {
  room: string;
  item: string;
  incoming_condition: string | null;
  outgoing_condition: string | null;
  incoming_note: string | null;
  outgoing_note: string | null;
  outgoing_finding_id: string | null;
  incoming_photos: string[] | null;
  outgoing_photos: string[] | null;
}

const RANK: Record<string, number> = { good: 0, fair: 1, poor: 2, damaged: 3, missing: 4 };

/** The whole point of keying findings on (room, item): the exit comparison is a join, and
    only a condition that got worse can justify a deduction. */
export const handler = route(async (event) => {
  const terminationId = event.pathParameters?.id;
  if (!terminationId) throw badRequest('A termination id is required.');
  await requireLeaseAccessVia(
    event,
    'select lease_id from termination where id = $1',
    [terminationId],
    'Termination',
  );

  const rows = await query<Row>(
    `with insp as (
       select i.kind, f.id, f.room, f.item, f.condition, f.note
         from termination t
         join inspection i on i.lease_id = t.lease_id
         join inspection_finding f on f.inspection_id = i.id
        where t.id = $1
     ),
     photos as (
       select f.id as finding_id, array_agg(p.s3_key order by p.uploaded_at) as keys
         from inspection_finding f
         join inspection_photo p on p.finding_id = f.id and p.uploaded
        group by f.id
     )
     select coalesce(inc.room, out.room) as room,
            coalesce(inc.item, out.item) as item,
            inc.condition as incoming_condition,
            out.condition as outgoing_condition,
            inc.note as incoming_note,
            out.note as outgoing_note,
            out.id as outgoing_finding_id,
            ip.keys as incoming_photos,
            op.keys as outgoing_photos
       from (select * from insp where kind = 'incoming') inc
       full outer join (select * from insp where kind = 'outgoing') out
         on out.room = inc.room and out.item = inc.item
       left join photos ip on ip.finding_id = inc.id
       left join photos op on op.finding_id = out.id
      order by 1, 2`,
    [terminationId],
  );

  const items = rows.map((row) => {
    const noBaseline = row.incoming_condition === null;
    const notReinspected = row.outgoing_condition === null;
    const before = RANK[row.incoming_condition ?? 'good'] ?? 0;
    const after = RANK[row.outgoing_condition ?? 'good'] ?? 0;
    const worsenedBy = noBaseline || notReinspected ? 0 : after - before;
    return {
      room: row.room,
      item: row.item,
      incoming: { condition: row.incoming_condition, note: row.incoming_note, photos: row.incoming_photos ?? [] },
      outgoing: { condition: row.outgoing_condition, note: row.outgoing_note, photos: row.outgoing_photos ?? [] },
      findingId: row.outgoing_finding_id,
      // An item the move-in inspection never recorded has no baseline. Treating it as having
      // started in good condition would let the landlord charge for damage that may predate
      // the tenant, which is exactly what a tribunal throws out.
      noBaseline,
      notReinspected,
      // Fair wear and tear is not damage. One step down is expected over a year of living
      // somewhere, so only a drop of two or more is offered as deductible.
      worsenedBy,
      deductible: !noBaseline && !notReinspected && worsenedBy >= 2,
    };
  });

  const [termination] = await query<{ status: string; statement_s3_key: string | null }>(
    'select status, statement_s3_key from termination where id = $1',
    [terminationId],
  );
  const deductions = await query<{
    id: string;
    description: string;
    amount_cents: string;
    finding_id: string | null;
    evidence_s3_key: string | null;
  }>(
    `select id, description, amount_cents, finding_id, evidence_s3_key
       from deposit_deduction where termination_id = $1 order by created_at`,
    [terminationId],
  );

  return json(200, {
    status: termination!.status,
    statementKey: termination!.statement_s3_key,
    deductions: deductions.map((row) => ({
      id: row.id,
      description: row.description,
      amountCents: Number(row.amount_cents),
      findingId: row.finding_id,
      evidenceKey: row.evidence_s3_key,
    })),
    items,
    summary: {
      unchanged: items.filter((item) => !item.noBaseline && !item.notReinspected && item.worsenedBy <= 0).length,
      wearAndTear: items.filter((item) => item.worsenedBy === 1).length,
      deductible: items.filter((item) => item.deductible).length,
      noBaseline: items.filter((item) => item.noBaseline).length,
      notReinspected: items.filter((item) => item.notReinspected).length,
    },
  });
});
