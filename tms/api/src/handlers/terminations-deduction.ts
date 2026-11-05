import { requireLeaseAccessVia } from '../lib/access';
import { audit } from '../lib/audit';
import { query, withTransaction } from '../lib/db';
import { badRequest, conflict, forbidden, json, notFound, parseBody, route } from '../lib/http';
import { addDeductionSchema, incomingInspectionSql, outgoingInWindowSql } from '../domain/termination';

export const handler = route(async (event) => {
  const terminationId = event.pathParameters?.id;
  if (!terminationId) throw badRequest('A termination id is required.');
  const access = await requireLeaseAccessVia(
    event,
    'select lease_id from termination where id = $1',
    [terminationId],
    'Termination',
  );
  if (!access.isLandlord) throw forbidden('Only the landlord proposes a deduction.');

  if (event.requestContext.http.method === 'DELETE') {
    const deductionId = event.pathParameters?.deductionId;
    if (!deductionId) throw badRequest('A deduction id is required.');
    await withTransaction(async (run) => {
      const [termination] = await run<{ status: string }>(
        'select status from termination where id = $1 for update',
        [terminationId],
      );
      if (!termination) throw notFound('Termination');
      // The statement and the ledger were written from these rows. Removing one afterwards
      // would leave the sealed statement claiming a deduction the list no longer shows.
      if (termination.status === 'settled') {
        throw conflict('This deposit is already settled, so its deductions are fixed.');
      }
      await run('delete from deposit_deduction where id = $1 and termination_id = $2', [
        deductionId,
        terminationId,
      ]);
    });
    return json(200, { removed: true });
  }

  const input = parseBody(event, addDeductionSchema);

  const created = await withTransaction(async (run) => {
    const [termination] = await run<{ status: string }>(
      'select status from termination where id = $1 for update',
      [terminationId],
    );
    if (!termination) throw notFound('Termination');
    if (termination.status === 'settled') throw conflict('This deposit is already settled.');
    if (termination.status === 'withdrawn') throw conflict('This notice was withdrawn, so there is no deposit to reconcile.');

    // A deduction with no outgoing finding behind it is exactly what tenants win disputes over.
    if (input.findingId) {
      // The baseline is the move-in inspection, which after a renewal sits on the lease the
      // renewal replaced: looking only at this lease found none, and nothing could be deducted.
      // The finding must be on the exit inspection that counts: not one replaced by a rebooking,
      // and inside the final window for the current end date.
      const [finding] = await run<{ id: string; condition: string; baseline: string | null }>(
        `select f.id, f.condition,
                (select inc.condition
                   from inspection_finding inc
                  where inc.inspection_id = ${incomingInspectionSql('i.lease_id')}
                    and inc.room = f.room and inc.item = f.item) as baseline
           from inspection_finding f
           join inspection i on i.id = f.inspection_id
           join termination t on t.lease_id = i.lease_id
          where f.id = $1 and t.id = $2 and ${outgoingInWindowSql('i', 't')}`,
        [input.findingId, terminationId],
      );
      if (!finding) throw badRequest('That finding is not on this lease’s outgoing inspection.');
      // The same damage is charged once. Two rows for one finding took it off the deposit twice.
      const [already] = await run<{ id: string }>(
        'select id from deposit_deduction where termination_id = $1 and finding_id = $2',
        [terminationId, input.findingId],
      );
      if (already) throw conflict('That finding already has a deduction. Remove it first to change the amount.');
      if (!['poor', 'damaged', 'missing'].includes(finding.condition)) {
        throw badRequest('Only a poor, damaged or missing item supports a deduction.');
      }
      // Without a move-in record there is nothing to show the item was ever undamaged.
      if (finding.baseline === null) {
        throw badRequest(
          'The move-in inspection never recorded this item, so there is no baseline to compare against and it cannot be deducted.',
        );
      }
      const RANK: Record<string, number> = { good: 0, fair: 1, poor: 2, damaged: 3, missing: 4 };
      if ((RANK[finding.condition] ?? 0) - (RANK[finding.baseline] ?? 0) < 2) {
        throw badRequest(
          'This item is one condition step below how it came in, which is fair wear and tear rather than damage.',
        );
      }
    }

    // The evidence key is stored as given and /files/view later treats any row holding a key
    // as authorisation to serve it. So it has to be a photo that already belongs to this
    // lease: an inspection photo or a ticket photo, uploaded. Anything else (a signature
    // image, another lease's document, a made-up path) is refused.
    if (input.evidenceS3Key) {
      const [evidence] = await run<{ ok: boolean }>(
        `select exists (
           select 1 from inspection_photo p
             join inspection_finding f on f.id = p.finding_id
             join inspection i on i.id = f.inspection_id
             join termination t on t.lease_id = i.lease_id
            where t.id = $1 and p.s3_key = $2 and p.uploaded
           union all
           select 1 from ticket_photo p
             join ticket tk on tk.id = p.ticket_id
             join termination t on t.lease_id = tk.lease_id
            where t.id = $1 and p.s3_key = $2 and p.uploaded
         ) as ok`,
        [terminationId, input.evidenceS3Key],
      );
      if (!evidence?.ok) throw badRequest('Evidence must be a photo on this lease.', { evidenceS3Key: 'Not a photo on this lease.' });
    }

    let row: { id: string } | undefined;
    try {
      [row] = await run<{ id: string }>(
        `insert into deposit_deduction (termination_id, finding_id, description, amount_cents, evidence_s3_key)
         values ($1, $2, $3, $4, $5) returning id`,
        [terminationId, input.findingId ?? null, input.description, input.amountCents, input.evidenceS3Key ?? null],
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw conflict('That finding already has a deduction. Remove it first to change the amount.');
      }
      throw error;
    }
    await run("update termination set status = 'reconciling' where id = $1 and status <> 'settled'", [
      terminationId,
    ]);
    return { id: row!.id };
  });

  await audit({
    actorSub: access.person.sub,
    actorRole: 'landlord',
    action: 'termination.deduction_added',
    entity: 'termination',
    entityId: terminationId,
    detail: { amountCents: input.amountCents, description: input.description },
  });

  return json(201, created);
});
