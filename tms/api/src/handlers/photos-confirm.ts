import { z } from 'zod';
import { requireLeaseAccessVia } from '../lib/access';
import { query } from '../lib/db';
import { storage } from '../lib/storage';
import { badRequest, json, notFound, parseBody, route } from '../lib/http';

const schema = z.object({ scope: z.enum(['inspection', 'ticket']), photoId: z.guid() });

/** The client calls this after the PUT succeeds. Only confirmed photos reach a sealed report,
    so an abandoned upload is invisible instead of fatal. */
export const handler = route(async (event) => {
  const input = parseBody(event, schema);
  const table = input.scope === 'inspection' ? 'inspection_photo' : 'ticket_photo';
  const leaseSql =
    input.scope === 'inspection'
      ? `select i.lease_id from inspection_photo p
           join inspection_finding f on f.id = p.finding_id
           join inspection i on i.id = f.inspection_id
          where p.id = $1`
      : `select t.lease_id from ticket_photo p join ticket t on t.id = p.ticket_id where p.id = $1`;
  await requireLeaseAccessVia(event, leaseSql, [input.photoId], 'Photo');

  const [photo] = await query<{ s3_key: string }>(
    `select s3_key from ${table} where id = $1`,
    [input.photoId],
  );
  if (!photo) throw notFound('Photo');

  try {
    const size = await storage().sizeOf(photo.s3_key);
    if (size === null) throw notFound('Uploaded photo');
  } catch {
    throw badRequest('That upload has not landed yet. Retry the upload, then confirm.');
  }

  await query(`update ${table} set uploaded = true where id = $1`, [input.photoId]);
  return json(200, { confirmed: true });
});
