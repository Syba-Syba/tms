import { requireOwner } from '../lib/access';
import { audit } from '../lib/audit';
import { requireLandlord } from '../lib/auth';
import { query } from '../lib/db';
import { badRequest, json, notFound, route } from '../lib/http';

export const handler = route(async (event) => {
  const inviteId = event.pathParameters?.id;
  if (!inviteId) throw badRequest('An invite id is required.');
  const person = requireLandlord(event);
  const { landlordId } = await requireOwner(person);
  const [revoked] = await query<{ email: string }>(
    `update landlord_invite set revoked_at = now()
      where id = $1 and landlord_id = $2 and accepted_at is null and revoked_at is null returning email`,
    [inviteId, landlordId],
  );
  if (!revoked) throw notFound('Invite');
  await audit({
    actorSub: person.sub, actorRole: 'landlord', action: 'landlord.invite_revoked', entity: 'landlord',
    entityId: landlordId, detail: { email: revoked.email, inviteId },
  });
  return json(200, { ok: true });
});
