import { requireLeaseAccessVia } from '../lib/access';
import { query } from '../lib/db';
import { badRequest, json, route } from '../lib/http';

/**
 * The walkthrough screens were static mockups because nothing served the live state. This is
 * that state: every finding as seeded, photos on file, who has signed, and the report keys.
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

  const [inspection] = await query<{
    id: string;
    kind: string;
    status: string;
    scheduled_for: string;
    lease_id: string;
    unit_label: string;
    pdf_s3_key: string | null;
    draft_s3_key: string | null;
    draft_sha256: string | null;
  }>(
    `select i.id, i.kind, i.status, i.scheduled_for, i.lease_id, i.pdf_s3_key,
            i.draft_s3_key, i.draft_sha256,
            p.name || ' ' || u.code as unit_label
       from inspection i
       join lease l on l.id = i.lease_id
       join unit u on u.id = l.unit_id
       join property p on p.id = u.property_id
      where i.id = $1`,
    [inspectionId],
  );

  const findings = await query<{
    id: string;
    room: string;
    item: string;
    condition: string;
    note: string | null;
  }>(
    `select id, room, item, condition, note from inspection_finding
      where inspection_id = $1 order by room, item`,
    [inspectionId],
  );

  const photos = await query<{ finding_id: string; s3_key: string }>(
    `select p.finding_id, p.s3_key from inspection_photo p
       join inspection_finding f on f.id = p.finding_id
      where f.inspection_id = $1 and p.uploaded order by p.uploaded_at`,
    [inspectionId],
  );
  const photosByFinding = new Map<string, string[]>();
  for (const photo of photos) {
    photosByFinding.set(photo.finding_id, [
      ...(photosByFinding.get(photo.finding_id) ?? []),
      photo.s3_key,
    ]);
  }

  const signatures = await query<{ party: string; signed_at: string }>(
    'select party, signed_at from inspection_signature where inspection_id = $1',
    [inspectionId],
  );

  return json(200, {
    id: inspection!.id,
    kind: inspection!.kind,
    status: inspection!.status,
    scheduledFor: inspection!.scheduled_for,
    leaseId: inspection!.lease_id,
    unit: inspection!.unit_label,
    reportKey: inspection!.pdf_s3_key,
    draftKey: inspection!.draft_s3_key,
    draftSha256: inspection!.draft_sha256,
    viewer: { isLandlord: access.isLandlord, isTenant: access.isTenant },
    signatures: signatures.map((row) => ({ party: row.party, signedAt: row.signed_at })),
    findings: findings.map((row) => ({
      id: row.id,
      room: row.room,
      item: row.item,
      condition: row.condition,
      note: row.note,
      photoKeys: photosByFinding.get(row.id) ?? [],
    })),
  });
});
