import { z } from 'zod';
import { requireLeaseAccessVia } from '../lib/access';
import { query } from '../lib/db';
import { storage } from '../lib/storage';
import { badRequest, conflict, json, notFound, parseBody, route } from '../lib/http';
import { requireUploadLinkAllowance, uploadLinksByAccount } from '../lib/ratelimit';
import { roomName } from '../domain/inspection';

/** Unconfirmed photo uploads one inspection may have in the last hour. */
export const MAX_PENDING_INSPECTION_PHOTOS = 20;

const schema = z.object({
  room: roomName,
  item: roomName,
  contentType: z.enum(['image/jpeg', 'image/png']),
  sizeBytes: z.number().int().positive().max(10 * 1024 * 1024),
});

export const handler = route(async (event) => {
  const inspectionId = event.pathParameters?.id;
  if (!inspectionId) throw badRequest('An inspection id is required.');
  const access = await requireLeaseAccessVia(
    event,
    'select lease_id from inspection where id = $1',
    [inspectionId],
    'Inspection',
  );
  const input = parseBody(event, schema);
  requireUploadLinkAllowance(access.person.sub);

  const [finding] = await query<{ id: string }>(
    `select f.id from inspection_finding f
       join inspection i on i.id = f.inspection_id
      where f.inspection_id = $1 and f.room = $2 and f.item = $3 and i.status = 'in_progress'`,
    [inspectionId, input.room, input.item],
  );
  if (!finding) throw notFound('Finding');

  // Abandoned uploads count for an hour, until the uploads sweep deletes them.
  const [pending] = await query<{ n: number }>(
    `select count(*)::int as n from inspection_photo p
       join inspection_finding f on f.id = p.finding_id
      where f.inspection_id = $1 and not p.uploaded and p.uploaded_at > now() - interval '1 hour'`,
    [inspectionId],
  );
  if (pending!.n >= MAX_PENDING_INSPECTION_PHOTOS) {
    throw conflict('Too many photos are waiting to be confirmed on this inspection. Finish those first, or try again in an hour.');
  }

  const key = `inspections/${inspectionId}/${crypto.randomUUID()}.${input.contentType === 'image/png' ? 'png' : 'jpg'}`;
  const uploadUrl = await storage().presignPut(key, input.contentType, 300);

  // uploaded stays false until the client confirms. A row whose object never arrived must
  // not break the sealing step later.
  const [photo] = await query<{ id: string }>(
    `insert into inspection_photo (finding_id, s3_key, content_type, size_bytes)
     values ($1, $2, $3, $4) returning id`,
    [finding.id, key, input.contentType, input.sizeBytes],
  );

  uploadLinksByAccount.record(access.person.sub);
  return json(201, { photoId: photo!.id, uploadUrl, key, expiresInSeconds: 300 });
});
