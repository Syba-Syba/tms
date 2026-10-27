import { assertSigningAs, requireLeaseAccessVia } from '../lib/access';
import { audit } from '../lib/audit';
import { query, withTransaction } from '../lib/db';
import { storage } from '../lib/storage';
import { badRequest, conflict, json, notFound, parseBody, route } from '../lib/http';
import { signInspectionSchema } from '../domain/inspection';
import { pngBytesFromDataUrl, sniffImageType } from '../lib/images';
import { renderInspectionPdf, type InspectionData, type InspectionPhoto } from '../lib/pdf';
import { logger } from '../lib/logger';

/** Three per finding keeps the report a document, not a photo dump. */
const PHOTOS_PER_FINDING = 3;
/**
 * The whole report's photo budget. pdf-lib embeds photos at their original size, so a 120
 * finding walkthrough with three phone photos each could reach hundreds of megabytes and
 * exhaust Lambda's memory. Past these, photos stay on file and the report says how many.
 */
const MAX_PHOTOS = 60;
const MAX_PHOTO_BYTES = 40 * 1024 * 1024;

/** A missing photo must not block the seal. Losing one thumbnail is recoverable; leaving the
    report unsigned because of it is not. */
const bytesOrNull = async (key: string) => {
  try {
    return await storage().get(key);
  } catch (error) {
    logger.warn('Photo missing at seal time.', { key, error });
    return null;
  }
};

/**
 * The findings and photos exactly as the report embeds them, shared by the draft both parties
 * review and the sealed report, so the two differ by the signature block alone. Photos are
 * fetched one at a time: a fan-out across every finding held every photo in memory at once.
 */
export async function collectReportFindings(inspectionId: string): Promise<{
  findings: InspectionData['findings'];
  photosOmitted: number;
}> {
  const findings = await query<{ id: string; room: string; item: string; condition: string; note: string | null }>(
    `select id, room, item, condition, note from inspection_finding
      where inspection_id = $1 order by room, item`,
    [inspectionId],
  );
  const photoRows = await query<{ finding_id: string; s3_key: string }>(
    `select p.finding_id, p.s3_key
       from inspection_photo p
       join inspection_finding f on f.id = p.finding_id
      where f.inspection_id = $1 and p.uploaded
      order by p.uploaded_at`,
    [inspectionId],
  );
  const byFinding = new Map<string, string[]>();
  for (const row of photoRows) {
    const list = byFinding.get(row.finding_id) ?? [];
    if (list.length < PHOTOS_PER_FINDING) list.push(row.s3_key);
    byFinding.set(row.finding_id, list);
  }

  let embedded = 0;
  let embeddedBytes = 0;
  let omitted = 0;
  const result: InspectionData['findings'] = [];
  for (const finding of findings) {
    const photos: InspectionPhoto[] = [];
    for (const key of byFinding.get(finding.id) ?? []) {
      if (embedded >= MAX_PHOTOS || embeddedBytes >= MAX_PHOTO_BYTES) {
        omitted += 1;
        continue;
      }
      const bytes = await bytesOrNull(key);
      if (!bytes) continue;
      // The stored content type is whatever the client claimed. The bytes decide.
      const type = sniffImageType(bytes);
      if (!type) {
        logger.warn('Photo is neither PNG nor JPEG; left out of the report.', { key });
        continue;
      }
      photos.push({ bytes, type });
      embedded += 1;
      embeddedBytes += bytes.byteLength;
    }
    result.push({ room: finding.room, item: finding.item, condition: finding.condition, note: finding.note, photos });
  }
  if (omitted > 0) logger.warn('Report photo budget reached.', { inspectionId, omitted });
  return { findings: result, photosOmitted: omitted };
}

async function sealReport(inspectionId: string) {
  const [meta] = await query<{ kind: 'incoming' | 'outgoing'; scheduled_for: string; unit_label: string }>(
    `select i.kind, i.scheduled_for::text, p.name || ' ' || u.code as unit_label
       from inspection i
       join lease l on l.id = i.lease_id
       join unit u on u.id = l.unit_id
       join property p on p.id = u.property_id
      where i.id = $1`,
    [inspectionId],
  );
  const { findings, photosOmitted } = await collectReportFindings(inspectionId);
  const signatures = await query<{ party: string; signed_at: string; signature_s3_key: string }>(
    `select party, signed_at::text, signature_s3_key from inspection_signature
      where inspection_id = $1 order by party`,
    [inspectionId],
  );
  const withImages = [];
  for (const signature of signatures) {
    withImages.push({
      party: signature.party,
      name: signature.party === 'landlord' ? 'Landlord' : 'Tenant',
      signedAt: signature.signed_at,
      png: await storage().get(signature.signature_s3_key),
    });
  }

  const rendered = await renderInspectionPdf({
    ref: `INS-${inspectionId.slice(0, 8).toUpperCase()}`,
    kind: meta!.kind,
    unitLabel: meta!.unit_label,
    date: meta!.scheduled_for,
    findings,
    photosOmitted,
    signatures: withImages,
  });

  const pdfKey = `inspections/${inspectionId}/report.pdf`;
  await storage().put(pdfKey, rendered.bytes, 'application/pdf');
  // 'completed' only once the report exists. Marking it first left a failed render as a
  // completed inspection with no document, which nothing could repair.
  await query(
    `update inspection
        set status = 'completed', pdf_s3_key = $2, pdf_sha256 = $3, completed_at = now()
      where id = $1 and status = 'awaiting_signatures'`,
    [inspectionId, pdfKey, rendered.sha256],
  );
}

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

  // Checked before anything is stored: a signature that is not a PNG would only surface
  // at seal time, as a 500, with both parties' signatures already on file.
  const signaturePng = pngBytesFromDataUrl(input.signatureBase64);
  if (!signaturePng) throw badRequest('The signature image is not a PNG.');
  const signatureKey = `inspections/${inspectionId}/signature-${input.party}.png`;

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

    // The other party may have signed an earlier draft. Two signatures over two different
    // documents are not a jointly signed report, so the stale one is withdrawn.
    const stale = await run<{ party: string }>(
      `delete from inspection_signature
        where inspection_id = $1 and party <> $2 and pdf_sha256 <> $3
        returning party`,
      [inspectionId, input.party, inspection.draft_sha256],
    );
    // Returned, not thrown: throwing here would roll the withdrawal back and leave the stale
    // signature in place, so the conflict is raised once the transaction has committed.
    if (stale.length > 0) return { withdrawn: true, bothSigned: false };

    // A party's own earlier signature over a superseded draft is replaced by this one; a
    // repeat over the same draft (a retry after a failed seal) leaves the original untouched.
    const inserted = await run<{ id: string }>(
      `insert into inspection_signature
         (inspection_id, party, signature_s3_key, pdf_sha256, ip_address, user_agent)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (inspection_id, party) do update
         set pdf_sha256 = excluded.pdf_sha256, signed_at = now(),
             ip_address = excluded.ip_address, user_agent = excluded.user_agent
         where inspection_signature.pdf_sha256 <> excluded.pdf_sha256
       returning id`,
      [
        inspectionId,
        input.party,
        signatureKey,
        input.pdfSha256,
        event.requestContext.http.sourceIp,
        event.headers['user-agent'] ?? null,
      ],
    );
    // Only a new signature writes its image. A repeat call (or a retry of a failed seal)
    // must not overwrite the image a sealed report already embeds.
    if (inserted.length > 0) await storage().put(signatureKey, signaturePng, 'image/png');

    const rows = await run<{ count: string }>(
      'select count(*)::text as count from inspection_signature where inspection_id = $1',
      [inspectionId],
    );
    const count = Number(rows[0]?.count ?? 0);
    await run("update inspection set status = 'awaiting_signatures' where id = $1", [inspectionId]);
    return { withdrawn: false, bothSigned: count === 2 };
  });

  if (state.withdrawn) {
    throw conflict('The report changed after the first signature. Both parties sign again.');
  }

  // Both parties on file: render the report with the signature images embedded and freeze it.
  // Outside the transaction, and a repeat POST from either party retries it if it failed.
  if (state.bothSigned) await sealReport(inspectionId);

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
