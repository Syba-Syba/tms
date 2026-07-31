import { requireLeaseAccessVia } from '../lib/access';
import { withTransaction } from '../lib/db';
import { badRequest, conflict, json, notFound, parseBody, route } from '../lib/http';
import { upsertFindingsSchema } from '../domain/inspection';

export const handler = route(async (event) => {
  const inspectionId = event.pathParameters?.id;
  if (!inspectionId) throw badRequest('An inspection id is required.');
  await requireLeaseAccessVia(
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
    return { saved: input.findings.length };
  });

  return json(200, result);
});
