import { requireLeaseAccessVia } from '../lib/access';
import { audit } from '../lib/audit';
import { withTransaction } from '../lib/db';
import { badRequest, conflict, json, notFound, parseBody, route } from '../lib/http';
import { MAX_FINDINGS, upsertFindingsSchema } from '../domain/inspection';
import { removeDraft, withdrawDraft } from './inspections-render';

export const handler = route(async (event) => {
  const inspectionId = event.pathParameters?.id;
  if (!inspectionId) throw badRequest('An inspection id is required.');
  const access = await requireLeaseAccessVia(
    event,
    'select lease_id from inspection where id = $1',
    [inspectionId],
    'Inspection',
  );
  const input = parseBody(event, upsertFindingsSchema);

  const result = await withTransaction(async (run) => {
    const [inspection] = await run<{ id: string; status: string }>(
      'select id, status from inspection where id = $1 for update',
      [inspectionId],
    );
    if (!inspection) throw notFound('Inspection');
    if (inspection.status !== 'in_progress') {
      throw conflict('This inspection is closed to changes.');
    }

    for (const finding of input.findings) {
      await run(
        `insert into inspection_finding (inspection_id, room, item, condition, note, updated_at)
         values ($1, $2, $3, $4, $5, now())
         on conflict (inspection_id, room, item)
         do update set condition = excluded.condition, note = excluded.note, updated_at = now()`,
        [inspectionId, finding.room, finding.item, finding.condition, finding.note ?? null],
      );
    }
    // Each finding is a page section in every render and seal, so an inspection holds a bounded number.
    const [count] = await run<{ n: number }>('select count(*)::int as n from inspection_finding where inspection_id = $1', [inspectionId]);
    if (count!.n > MAX_FINDINGS) throw conflict(`An inspection holds up to ${MAX_FINDINGS} findings.`);
    // The draft both parties review no longer describes these findings. Withdrawing its
    // fingerprint means a signature needs a fresh render; before this, findings could change
    // after review and a signature over the old draft would still have been accepted.
    const draft = await withdrawDraft(run, inspectionId);
    // A finding is the evidence a deposit deduction rests on, so who recorded what goes on file.
    await audit(
      {
        actorSub: access.person.sub,
        actorRole: access.isLandlord ? 'landlord' : 'tenant',
        action: 'inspection.findings_saved',
        entity: 'inspection',
        entityId: inspectionId,
        detail: { findings: input.findings },
      },
      run,
    );
    return { saved: input.findings.length, draft };
  });
  await removeDraft(result.draft);

  return json(200, { saved: result.saved });
});
