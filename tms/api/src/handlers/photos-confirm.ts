import { z } from 'zod';
import { requireLeaseAccessVia } from '../lib/access';
import { query } from '../lib/db';
import { storage } from '../lib/storage';
import { badRequest, json, notFound, parseBody, route } from '../lib/http';
import { sniffImageType } from '../lib/images';

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

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

  let size: number | null;
  try {
    size = await storage().sizeOf(photo.s3_key);
  } catch {
    size = null;
  }
  if (size === null) throw badRequest('That upload has not landed yet. Retry the upload, then confirm.');
  // A presigned PUT does not bind the body to the declared size, so the ceiling is checked here.
  if (size > MAX_PHOTO_BYTES) throw badRequest('Photos must be under 10 MB.');

  // The presign only checked the label the client sent. A photo that is not a JPEG or PNG
  // would be skipped from a sealed report, so it is refused while the uploader can still
  // retry. The stored type follows the bytes, not the label.
  const type = sniffImageType(await storage().get(photo.s3_key));
  if (!type) throw badRequest('That upload is not a JPEG or PNG photo.');

  await query(
    `update ${table} set uploaded = true, content_type = $2, size_bytes = $3 where id = $1`,
    [input.photoId, type === 'png' ? 'image/png' : 'image/jpeg', size],
  );
  return json(200, { confirmed: true });
});
