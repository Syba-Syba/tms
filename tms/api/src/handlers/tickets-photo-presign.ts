import { z } from 'zod';
import { requireLeaseAccessVia } from '../lib/access';
import { query } from '../lib/db';
import { storage } from '../lib/storage';
import { badRequest, conflict, json, parseBody, route } from '../lib/http';
import { requireUploadLinkAllowance, uploadLinksByAccount } from '../lib/ratelimit';

/** Unconfirmed photo uploads one ticket may have in the last hour. */
export const MAX_PENDING_TICKET_PHOTOS = 20;
/** Confirmed photos one ticket may keep for its report, and again for its completion. */
export const MAX_TICKET_PHOTOS = 20;

const schema = z.object({
  phase: z.enum(['report', 'completion']),
  contentType: z.enum(['image/jpeg', 'image/png']),
  sizeBytes: z.number().int().positive().max(10 * 1024 * 1024),
});

export const handler = route(async (event) => {
  const ticketId = event.pathParameters?.id;
  if (!ticketId) throw badRequest('A ticket id is required.');
  const access = await requireLeaseAccessVia(
    event,
    'select lease_id from ticket where id = $1',
    [ticketId],
    'Ticket',
  );
  const input = parseBody(event, schema);
  requireUploadLinkAllowance(access.person.sub);
  // Abandoned uploads count for an hour, until the uploads sweep deletes them.
  const [pending] = await query<{ n: number }>(
    `select count(*)::int as n from ticket_photo
      where ticket_id = $1 and not uploaded and uploaded_at > now() - interval '1 hour'`,
    [ticketId],
  );
  if (pending!.n >= MAX_PENDING_TICKET_PHOTOS) {
    throw conflict('Too many photos are waiting to be confirmed on this ticket. Finish those first, or try again in an hour.');
  }
  // Confirmed photos are kept, so they count too: the pending cap alone let a loop of uploads
  // add 10 MB at a time without end.
  const [kept] = await query<{ n: number }>(
    `select count(*)::int as n from ticket_photo where ticket_id = $1 and phase = $2 and uploaded`,
    [ticketId, input.phase],
  );
  if (kept!.n >= MAX_TICKET_PHOTOS) {
    throw conflict(`A ticket holds up to ${MAX_TICKET_PHOTOS} photos for each stage.`);
  }

  const key = `tickets/${ticketId}/${input.phase}-${crypto.randomUUID()}.${input.contentType === 'image/png' ? 'png' : 'jpg'}`;
  const uploadUrl = await storage().presignPut(key, input.contentType, 300);
  const [photo] = await query<{ id: string }>(
    `insert into ticket_photo (ticket_id, phase, s3_key, content_type, size_bytes)
     values ($1, $2, $3, $4, $5) returning id`,
    [ticketId, input.phase, key, input.contentType, input.sizeBytes],
  );
  uploadLinksByAccount.record(access.person.sub);
  return json(201, { photoId: photo!.id, uploadUrl, key, expiresInSeconds: 300 });
});
