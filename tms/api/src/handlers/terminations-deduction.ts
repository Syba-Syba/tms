import { requireLeaseAccessVia } from '../lib/access';
import { audit } from '../lib/audit';
import { query, withTransaction } from '../lib/db';
import { badRequest, conflict, forbidden, json, notFound, parseBody, route } from '../lib/http';
import { addDeductionSchema } from '../domain/termination';

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
    await query('delete from deposit_deduction where id = $1 and termination_id = $2', [
      deductionId,
      terminationId,
    ]);
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

    // A deduction with no outgoing finding behind it is exactly what tenants win disputes over.
    if (input.findingId) {
      const [finding] = await run<{ id: string; condition: string; baseline: string | null }>(
        `select f.id, f.condition,
                (select inc.condition
                   from inspection_finding inc
                   join inspection ii on ii.id = inc.inspection_id
                  where ii.lease_id = i.lease_id and ii.kind = 'incoming'
                    and inc.room = f.room and inc.item = f.item) as baseline
           from inspection_finding f
           join inspection i on i.id = f.inspection_id
           join termination t on t.lease_id = i.lease_id
          where f.id = $1 and t.id = $2 and i.kind = 'outgoing'`,
        [input.findingId, terminationId],
      );
      if (!finding) throw badRequest('That finding is not on this lease\u2019s outgoing inspection.');
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

    const [row] = await run<{ id: string }>(
      `insert into deposit_deduction (termination_id, finding_id, description, amount_cents, evidence_s3_key)
       values ($1, $2, $3, $4, $5) returning id`,
      [terminationId, input.findingId ?? null, input.description, input.amountCents, input.evidenceS3Key ?? null],
    );
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
