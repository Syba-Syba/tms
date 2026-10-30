import { z } from 'zod';
import { membershipOf, requireLeaseAccessVia } from '../lib/access';
import { requireLandlord } from '../lib/auth';
import { query, withTransaction } from '../lib/db';
import { storage } from '../lib/storage';
import { badRequest, conflict, json, notFound, parseBody, route } from '../lib/http';
import { sniffImageType } from '../lib/images';
import { isEmbeddableImage } from '../lib/pdf';

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

const schema = z.object({ scope: z.enum(['inspection', 'ticket', 'unit']), photoId: z.guid() });

const leaseSql = (scope: 'inspection' | 'ticket') =>
  scope === 'inspection'
    ? `select i.lease_id from inspection_photo p
         join inspection_finding f on f.id = p.finding_id
         join inspection i on i.id = f.inspection_id
        where p.id = $1`
    : `select t.lease_id from ticket_photo p join ticket t on t.id = p.ticket_id where p.id = $1`;

/** The client calls this after the PUT succeeds. Only confirmed photos reach a sealed report,
    so an abandoned upload is invisible instead of fatal. */
export const handler = route(async (event) => {
  const input = parseBody(event, schema);
  const table = input.scope === 'inspection' ? 'inspection_photo' : input.scope === 'ticket' ? 'ticket_photo' : 'unit_photo';
  if (input.scope === 'unit') {
    // A listing photo belongs to the landlord's account, not to a lease.
    const { landlordId } = await membershipOf(requireLandlord(event));
    const [own] = await query<{ id: string }>(
      `select ph.id from unit_photo ph join unit u on u.id = ph.unit_id join property p on p.id = u.property_id
        where ph.id = $1 and p.landlord_id = $2`,
      [input.photoId, landlordId],
    );
    if (!own) throw notFound('Photo');
  } else {
    await requireLeaseAccessVia(event, leaseSql(input.scope), [input.photoId], 'Photo');
  }

  const [photo] = await query<{ s3_key: string; uploaded: boolean }>(
    `select s3_key, uploaded from ${table} where id = $1`,
    [input.photoId],
  );
  if (!photo) throw notFound('Photo');
  // Confirming twice is a retry, not a second upload: the kept copy already stands.
  if (photo.uploaded) return json(200, { confirmed: true, key: photo.s3_key });

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
  const bytes = await storage().get(photo.s3_key);
  const type = sniffImageType(bytes);
  if (!type) throw badRequest('That upload is not a JPEG or PNG photo.');
  // The header alone passed a truncated file, which then failed every render of the report.
  if (!(await isEmbeddableImage(bytes, type))) {
    throw badRequest('That photo could not be read. It may be damaged; take it again and retry.');
  }
  const contentType = type === 'png' ? 'image/png' : 'image/jpeg';

  // The upload link stays valid for five minutes, so the uploader could PUT different bytes to
  // the same key after this check. The photo that counts is a copy of the bytes checked here,
  // under a key no upload link was ever issued for.
  const keptKey = `${photo.s3_key.replace(/\.[a-z]+$/, '')}.kept.${type === 'png' ? 'png' : 'jpg'}`;
  await storage().put(keptKey, bytes, contentType);

  if (input.scope === 'ticket' || input.scope === 'unit') {
    await query(
      `update ${table} set uploaded = true, s3_key = $4, content_type = $2, size_bytes = $3 where id = $1`,
      [input.photoId, contentType, size, keptKey],
    );
    await removeUpload(photo.s3_key, keptKey);
    return json(200, { confirmed: true, key: keptKey });
  }

  // A confirmed photo goes into the report, so it is evidence only while the findings are
  // open, and it withdraws the draft's fingerprint as a findings change does. Before this, a
  // photo confirmed after the draft was signed ended up in a sealed report nobody had seen.
  await withTransaction(async (run) => {
    const [inspection] = await run<{ id: string; status: string }>(
      `select i.id, i.status from inspection i
         join inspection_finding f on f.inspection_id = i.id
         join inspection_photo p on p.finding_id = f.id
        where p.id = $1
          for update of i`,
      [input.photoId],
    );
    if (!inspection) throw notFound('Photo');
    if (inspection.status !== 'in_progress') {
      throw conflict('This inspection is closed to changes.');
    }
    await run(
      `update inspection_photo set uploaded = true, s3_key = $4, content_type = $2, size_bytes = $3 where id = $1`,
      [input.photoId, contentType, size, keptKey],
    );
    await run('update inspection set draft_s3_key = null, draft_sha256 = null where id = $1', [inspection.id]);
  });
  await removeUpload(photo.s3_key, keptKey);
  return json(200, { confirmed: true, key: keptKey });
});

/** The raw upload, once the row points at the checked copy: no row would ever find it again,
    so erasure and deletes would leave it behind. A retried confirm reads the kept key. */
async function removeUpload(uploaded: string, kept: string) {
  if (uploaded !== kept) await storage().remove(uploaded).catch(() => undefined);
}
