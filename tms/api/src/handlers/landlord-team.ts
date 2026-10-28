import { membershipOf } from '../lib/access';
import { requireLandlord } from '../lib/auth';
import { query } from '../lib/db';
import { json, route } from '../lib/http';

/** Who works on this landlord account, and who has been asked to. Every member can see it. */
export const handler = route(async (event) => {
  const person = requireLandlord(event);
  const { landlordId } = await membershipOf(person);
  const members = await query<{ sub: string; role: string; name: string | null; email: string | null; created_at: string }>(
    `select m.sub, m.role, coalesce(c.name, l.trading_name) as name, coalesce(c.email, l.email) as email,
            m.created_at::text
       from landlord_member m
       join landlord l on l.id = m.landlord_id
       left join local_credential c on c.sub = m.sub
      where m.landlord_id = $1
      order by m.role desc, m.created_at`,
    [landlordId],
  );
  const invites = await query<{ id: string; name: string; email: string; expires_at: string; created_at: string }>(
    `select id, name, email, expires_at::text, created_at::text from landlord_invite
      where landlord_id = $1 and accepted_at is null and revoked_at is null and expires_at > now()
      order by created_at desc`,
    [landlordId],
  );
  return json(200, {
    members: members.map((row) => ({
      sub: row.sub, role: row.role, name: row.name, email: row.email, since: row.created_at, isYou: row.sub === person.sub,
    })),
    invites: invites.map((row) => ({ id: row.id, name: row.name, email: row.email, expiresAt: row.expires_at, sentAt: row.created_at })),
  });
});
