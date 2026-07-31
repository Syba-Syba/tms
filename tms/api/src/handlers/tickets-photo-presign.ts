import { z } from 'zod';
import { requireLeaseAccessVia } from '../lib/access';
import { query } from '../lib/db';
import { storage } from '../lib/storage';
import { badRequest, json, parseBody, route } from '../lib/http';

const schema = z.object({
  phase: z.enum(['report', 'completion']),
  contentType: z.enum(['image/jpeg', 'image/png']),
  sizeBytes: z.number().int().positive().max(10 * 1024 * 1024),
});

export const handler = route(async (event) => {
  const ticketId = event.pathParameters?.id;
  if (!ticketId) throw badRequest('A ticket id is required.');
  await requireLeaseAccessVia(
    event,
    'select lease_id from ticket where id = $1',
    [ticketId],
    'Ticket',
  );
  const input = parseBody(event, schema);

  const key = `tickets/${ticketId}/${input.phase}-${crypto.randomUUID()}.${input.contentType === 'image/png' ? 'png' : 'jpg'}`;
  const uploadUrl = await storage().presignPut(key, input.contentType, 300);
  const [photo] = await query<{ id: string }>(
    `insert into ticket_photo (ticket_id, phase, s3_key, content_type, size_bytes)
     values ($1, $2, $3, $4, $5) returning id`,
    [ticketId, input.phase, key, input.contentType, input.sizeBytes],
  );
  return json(201, { photoId: photo!.id, uploadUrl, key, expiresInSeconds: 300 });
});
