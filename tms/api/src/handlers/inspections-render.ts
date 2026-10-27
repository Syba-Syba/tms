import { requireLeaseAccessVia } from '../lib/access';
import { randomUUID } from 'node:crypto';
import { query, withTransaction } from '../lib/db';
import { badRequest, conflict, json, route } from '../lib/http';
import { renderInspectionPdf } from '../lib/pdf';
import { storage } from '../lib/storage';
import { collectReportFindings } from './inspections-sign';

/**
 * Signing attests a SHA-256, so the report has to exist before anyone signs it. This renders
 * the unsigned draft both parties review; the seal on the second signature re-renders it with
 * the signature images embedded and stores that as the final report.
 *
 * The draft carries the same photos as the sealed report. It used to carry none, so the
 * document the parties fingerprinted was not the document their signatures ended up on.
 */
export const handler = route(async (event) => {
  const inspectionId = event.pathParameters?.id;
  if (!inspectionId) throw badRequest('An inspection id is required.');
  await requireLeaseAccessVia(
    event,
    'select lease_id from inspection where id = $1',
    [inspectionId],
    'Inspection',
  );

  const [inspection] = await query<{
    ref: string;
    kind: 'incoming' | 'outgoing';
    status: string;
    scheduled_for: string;
    unit_label: string;
  }>(
    `select 'INS-' || upper(left(i.id::text, 8)) as ref, i.kind, i.status, i.scheduled_for::text,
            p.name || ' ' || u.code as unit_label
       from inspection i
       join lease l on l.id = i.lease_id
       join unit u on u.id = l.unit_id
       join property p on p.id = u.property_id
      where i.id = $1`,
    [inspectionId],
  );
  if (!['in_progress', 'awaiting_signatures'].includes(inspection!.status)) {
    throw conflict(`This inspection is ${inspection!.status}.`);
  }

  // The render is claimed before the findings are read: the draft key is set to this render's
  // own key and the old fingerprint withdrawn. A findings save or photo confirm clears the key,
  // and a later render replaces it, so the fingerprint is stored below only if neither
  // happened. Before, a save in between was missing from a draft that was then signed.
  const key = `inspections/${inspectionId}/draft-${randomUUID()}.pdf`;
  await withTransaction(async (run) => {
    const [row] = await run<{ status: string }>('select status from inspection where id = $1 for update', [
      inspectionId,
    ]);
    if (!['in_progress', 'awaiting_signatures'].includes(row!.status)) {
      throw conflict(`This inspection is ${row!.status}.`);
    }
    await run('update inspection set draft_s3_key = $2, draft_sha256 = null where id = $1', [inspectionId, key]);
  });

  const { findings, photosOmitted } = await collectReportFindings(inspectionId);
  const rendered = await renderInspectionPdf({
    ref: inspection!.ref,
    kind: inspection!.kind,
    unitLabel: inspection!.unit_label,
    date: inspection!.scheduled_for,
    findings,
    photosOmitted,
    signatures: [],
    draft: true,
  });

  await storage().put(key, rendered.bytes, 'application/pdf');
  const stored = await query<{ id: string }>(
    `update inspection set draft_sha256 = $3
      where id = $1 and draft_s3_key = $2 and status in ('in_progress', 'awaiting_signatures')
      returning id`,
    [inspectionId, key, rendered.sha256],
  );
  if (stored.length === 0) {
    throw conflict('The inspection changed while the report was rendering. Render it again.');
  }

  return json(200, { key, sha256: rendered.sha256 });
});
