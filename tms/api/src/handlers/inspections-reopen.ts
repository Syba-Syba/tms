import { requireLeaseAccessVia } from '../lib/access';
import { audit } from '../lib/audit';
import { withTransaction } from '../lib/db';
import { badRequest, conflict, json, notFound, route } from '../lib/http';
import { removeDraft, withdrawDraft } from './inspections-render';

/**
 * Returns an inspection awaiting signatures to 'in_progress', so a disputed finding can be
 * fixed. Without it, findings locked at the first signature and a party who disagreed had no
 * way forward but to sign something they disputed. Either party may reopen it until both have
 * signed; the sealed report is final. Any signature given is withdrawn along with the draft,
 * because it attested a document that is about to change.
 */
export const handler = route(async (event) => {
  const inspectionId = event.pathParameters?.id;
  if (!inspectionId) throw badRequest('An inspection id is required.');
  const access = await requireLeaseAccessVia(
    event,
    'select lease_id from inspection where id = $1',
    [inspectionId],
    'Inspection',
  );

  const result = await withTransaction(async (run) => {
    const [inspection] = await run<{ status: string }>('select status from inspection where id = $1 for update', [
      inspectionId,
    ]);
    if (!inspection) throw notFound('Inspection');
    // Already open: a repeat tap is not an error.
    if (inspection.status === 'in_progress') return { changed: false, withdrawn: [] as string[], draft: null };
    if (inspection.status !== 'awaiting_signatures') {
      throw conflict(`This inspection is ${inspection.status} and can no longer be reopened.`);
    }

    // Both signatures on file means the parties agreed; only the seal is outstanding, and a
    // repeat signature retries it. Reopening then would undo a joint signing.
    const [signed] = await run<{ count: string }>(
      'select count(*)::text as count from inspection_signature where inspection_id = $1',
      [inspectionId],
    );
    if (Number(signed?.count ?? 0) >= 2) {
      throw conflict('Both parties have signed this inspection. It can no longer be reopened.');
    }

    const withdrawn = await run<{ party: string }>(
      'delete from inspection_signature where inspection_id = $1 returning party',
      [inspectionId],
    );
    const draft = await withdrawDraft(run, inspectionId, `status = 'in_progress', `);
    // Withdrawing someone's signature is a step either side may later need to account for.
    await audit(
      {
        actorSub: access.person.sub,
        actorRole: access.isLandlord ? 'landlord' : 'tenant',
        action: 'inspection.reopened',
        entity: 'inspection',
        entityId: inspectionId,
        detail: { signaturesWithdrawn: withdrawn.map((row) => row.party) },
      },
      run,
    );
    return { changed: true, withdrawn: withdrawn.map((row) => row.party), draft };
  });
  await removeDraft(result.draft);

  return json(200, { status: 'in_progress', signaturesWithdrawn: result.withdrawn });
});
