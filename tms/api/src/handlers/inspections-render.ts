import { requireLeaseAccessVia } from '../lib/access';
import { query } from '../lib/db';
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

  const key = `inspections/${inspectionId}/draft.pdf`;
  await storage().put(key, rendered.bytes, 'application/pdf');
  await query('update inspection set draft_s3_key = $2, draft_sha256 = $3 where id = $1', [
    inspectionId,
    key,
    rendered.sha256,
  ]);

  return json(200, { key, sha256: rendered.sha256 });
});
