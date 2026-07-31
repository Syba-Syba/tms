import { assertSigningAs, requireLeaseAccessVia } from '../lib/access';
import { audit } from '../lib/audit';
import { query, withTransaction } from '../lib/db';
import { storage } from '../lib/storage';
import { badRequest, conflict, json, notFound, parseBody, route } from '../lib/http';
import { signInspectionSchema } from '../domain/inspection';
import { renderInspectionPdf, type InspectionPhoto } from '../lib/pdf';

const asBytes = (key: string) => storage().get(key);

async function collectPhotos(
  rows: { s3_key: string; content_type: string }[],
): Promise<InspectionPhoto[]> {
  const fetched = await Promise.all(
    rows.map(async (row) => {
      const bytes = await asBytesOrNull(row.s3_key);
      if (!bytes) return null;
      const type: InspectionPhoto['type'] = row.content_type === 'image/png' ? 'png' : 'jpg';
      return { bytes, type };
    }),
  );
  // Contextual typing on push keeps this aligned with InspectionPhoto without a cast.
  const photos: InspectionPhoto[] = [];
  for (const photo of fetched) if (photo) photos.push(photo);
  return photos;
}

/** A missing photo must not block the seal. Losing one thumbnail is recoverable; leaving the
    report unsigned because of it is not. */
const asBytesOrNull = async (key: string) => {
  try {
    return await asBytes(key);
  } catch (error) {
    console.error('Photo missing at seal time', key, error);
    return null;
  }
};

export const handler = route(async (event) => {
  const inspectionId = event.pathParameters?.id;
  if (!inspectionId) throw badRequest('An inspection id is required.');
  const input = parseBody(event, signInspectionSchema);
  const access = await requireLeaseAccessVia(
    event,
    'select lease_id from inspection where id = $1',
    [inspectionId],
    'Inspection',
  );
  assertSigningAs(access, input.party);
  const person = access.person;

  const signatureKey = `inspections/${inspectionId}/signature-${input.party}.png`;
  await storage().put(
    signatureKey,
    Buffer.from(input.signatureBase64.replace(/^data:image\/png;base64,/, ''), 'base64'),
    'image/png',
  );

  const state = await withTransaction(async (run) => {
    const [inspection] = await run<{ id: string; status: string; draft_sha256: string | null }>(
      'select id, status, draft_sha256 from inspection where id = $1 for update',
      [inspectionId],
    );
    if (!inspection) throw notFound('Inspection');
    if (!['in_progress', 'awaiting_signatures'].includes(inspection.status)) {
      throw conflict(`This inspection is ${inspection.status}.`);
    }
    // A signature over an unseen or superseded report is worthless in a dispute.
    if (!inspection.draft_sha256) {
      throw conflict('Render the report before signing it.');
    }
    if (inspection.draft_sha256 !== input.pdfSha256) {
      throw conflict('The report changed since it was reviewed. Reopen it and sign again.');
    }

    await run(
      `insert into inspection_signature
         (inspection_id, party, signature_s3_key, pdf_sha256, ip_address, user_agent)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (inspection_id, party) do nothing`,
      [
        inspectionId,
        input.party,
        signatureKey,
        input.pdfSha256,
        event.requestContext.http.sourceIp,
        event.headers['user-agent'] ?? null,
      ],
    );

    const rows = await run<{ count: string }>(
      'select count(*)::text as count from inspection_signature where inspection_id = $1',
      [inspectionId],
    );
    const count = Number(rows[0]?.count ?? 0);
    await run('update inspection set status = $2 where id = $1', [
      inspectionId,
      count === 2 ? 'completed' : 'awaiting_signatures',
    ]);
    return { bothSigned: count === 2 };
  });

  // Both parties on file: render the report with the signature images embedded and freeze it.
  if (state.bothSigned) {
    const [meta] = await query<{
      kind: 'incoming' | 'outgoing';
      scheduled_for: string;
      unit_label: string;
    }>(
      `select i.kind, i.scheduled_for::text, p.name || ' ' || u.code as unit_label
         from inspection i
         join lease l on l.id = i.lease_id
         join unit u on u.id = l.unit_id
         join property p on p.id = u.property_id
        where i.id = $1`,
      [inspectionId],
    );
    const findings = await query<{ id: string; room: string; item: string; condition: string; note: string | null }>(
      `select id, room, item, condition, note from inspection_finding
        where inspection_id = $1 order by room, item`,
      [inspectionId],
    );
    const photoRows = await query<{ finding_id: string; s3_key: string; content_type: string }>(
      `select p.finding_id, p.s3_key, p.content_type
         from inspection_photo p
         join inspection_finding f on f.id = p.finding_id
        where f.inspection_id = $1 and p.uploaded
        order by p.uploaded_at`,
      [inspectionId],
    );
    const photosByFinding = new Map<string, { s3_key: string; content_type: string }[]>();
    for (const row of photoRows) {
      const list = photosByFinding.get(row.finding_id) ?? [];
      // Three per finding keeps the report a document, not a photo dump.
      if (list.length < 3) list.push(row);
      photosByFinding.set(row.finding_id, list);
    }
    const findingsWithPhotos = await Promise.all(
      findings.map(async (finding) => ({
        room: finding.room,
        item: finding.item,
        condition: finding.condition,
        note: finding.note,
        photos: await collectPhotos(photosByFinding.get(finding.id) ?? []),
      })),
    );
    const signatures = await query<{ party: string; signed_at: string; signature_s3_key: string }>(
      `select party, signed_at::text, signature_s3_key from inspection_signature
        where inspection_id = $1 order by party`,
      [inspectionId],
    );

    const rendered = await renderInspectionPdf({
      ref: `INS-${inspectionId.slice(0, 8).toUpperCase()}`,
      kind: meta!.kind,
      unitLabel: meta!.unit_label,
      date: meta!.scheduled_for,
      findings: findingsWithPhotos,
      signatures: await Promise.all(
        signatures.map(async (signature) => ({
          party: signature.party,
          name: signature.party === 'landlord' ? 'Landlord' : 'Tenant',
          signedAt: signature.signed_at,
          png: await asBytes(signature.signature_s3_key),
        })),
      ),
    });

    const pdfKey = `inspections/${inspectionId}/report.pdf`;
    await storage().put(pdfKey, rendered.bytes, 'application/pdf');
    await query('update inspection set pdf_s3_key = $2, pdf_sha256 = $3, completed_at = now() where id = $1', [
      inspectionId,
      pdfKey,
      rendered.sha256,
    ]);
  }

  await audit({
    actorSub: person.sub,
    actorRole: input.party,
    action: 'inspection.signed',
    entity: 'inspection',
    entityId: inspectionId,
    detail: { party: input.party, bothSigned: state.bothSigned },
  });

  return json(200, { status: state.bothSigned ? 'completed' : 'awaiting_signatures' });
});
