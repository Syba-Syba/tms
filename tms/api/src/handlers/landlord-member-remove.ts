import { requireOwner } from '../lib/access';
import { audit } from '../lib/audit';
import { requireLandlord } from '../lib/auth';
import { withTransaction } from '../lib/db';
import { badRequest, conflict, json, notFound, route } from '../lib/http';

/** The owner takes someone off the account. Their sessions end at once: the membership goes and
    their session epoch moves, so a token they still hold stops working on the next request. */
export const handler = route(async (event) => {
  const sub = event.pathParameters?.sub;
  if (!sub) throw badRequest('A member is required.');
  const person = requireLandlord(event);
  const { landlordId } = await requireOwner(person);
  if (sub === person.sub) throw conflict('You own this account, so you cannot remove yourself.');

  const removed = await withTransaction(async (run) => {
    const [row] = await run<{ role: string }>(
      `delete from landlord_member where landlord_id = $1 and sub = $2 and role = 'agent' returning role`,
      [landlordId, sub],
    );
    if (!row) return false;
    await run('update local_credential set session_epoch = session_epoch + 1 where sub = $1', [sub]);
    return true;
  });
  if (!removed) throw notFound('Member');

  await audit({
    actorSub: person.sub, actorRole: 'landlord', action: 'landlord.member_removed', entity: 'landlord',
    entityId: landlordId, detail: { sub },
  });
  return json(200, { ok: true });
});
