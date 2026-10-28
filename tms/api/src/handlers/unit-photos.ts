import { z } from 'zod';
import { membershipOf } from '../lib/access';
import { audit } from '../lib/audit';
import { requireLandlord } from '../lib/auth';
import { query } from '../lib/db';
import { badRequest, conflict, json, notFound, parseBody, route } from '../lib/http';
import { storage } from '../lib/storage';

export const MAX_UNIT_PHOTOS = 12;

const schema = z.object({
  contentType: z.enum(['image/jpeg', 'image/png']),
  sizeBytes: z.number().int().positive().max(10 * 1024 * 1024),
});

/** The unit, if it belongs to the caller's landlord account. */
async function ownUnit(landlordId: string, unitId: string) {
  const [unit] = await query<{ id: string }>(
    'select u.id from unit u join property p on p.id = u.property_id where u.id = $1 and p.landlord_id = $2',
    [unitId, landlordId],
  );
  if (!unit) throw notFound('Unit');
}

/**
 * POST /units/{id}/photos: a five-minute upload link for one listing photo. The app then
 * confirms it through /photos/confirm, which reads the bytes and keeps a checked copy.
 * DELETE /units/{id}/photos/{photoId}: takes a photo off the listing and out of storage.
 */
export const handler = route(async (event) => {
  const person = requireLandlord(event);
  const { landlordId } = await membershipOf(person);
  const unitId = event.pathParameters?.id;
  if (!unitId) throw badRequest('A unit id is required.');
  await ownUnit(landlordId, unitId);

  if (event.requestContext.http.method === 'DELETE') {
    const photoId = event.pathParameters?.photoId ?? '';
    if (!/^[0-9a-f-]{36}$/i.test(photoId)) throw notFound('Photo');
    const [photo] = await query<{ s3_key: string }>(
      'delete from unit_photo where id = $1 and unit_id = $2 returning s3_key',
      [photoId, unitId],
    );
    if (!photo) throw notFound('Photo');
    // The checked copy, and the raw upload it was made from.
    await storage().remove(photo.s3_key);
    await storage().remove(photo.s3_key.replace(/\.kept\.(png|jpg)$/, '.$1'));
    await audit({ actorSub: person.sub, actorRole: 'landlord', action: 'unit.photo_removed', entity: 'unit', entityId: unitId });
    return json(200, { removed: true });
  }

  const input = parseBody(event, schema);
  // Abandoned uploads count for an hour, so a loop cannot pile up unconfirmed rows.
  const [count] = await query<{ n: string }>(
    `select count(*)::text as n from unit_photo
      where unit_id = $1 and (uploaded or created_at > now() - interval '1 hour')`,
    [unitId],
  );
  if (Number(count!.n) >= MAX_UNIT_PHOTOS) throw conflict(`A listing holds up to ${MAX_UNIT_PHOTOS} photos. Remove one first.`);

  const key = `units/${unitId}/${crypto.randomUUID()}.${input.contentType === 'image/png' ? 'png' : 'jpg'}`;
  const uploadUrl = await storage().presignPut(key, input.contentType, 300);
  const [photo] = await query<{ id: string }>(
    `insert into unit_photo (unit_id, s3_key, content_type, size_bytes, position)
     values ($1, $2, $3, $4, (select coalesce(max(position), -1) + 1 from unit_photo where unit_id = $1))
     returning id`,
    [unitId, key, input.contentType, input.sizeBytes],
  );
  return json(201, { photoId: photo!.id, uploadUrl, key, expiresInSeconds: 300 });
});
