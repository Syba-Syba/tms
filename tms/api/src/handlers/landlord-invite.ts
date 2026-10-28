import { requireOwner } from '../lib/access';
import { audit } from '../lib/audit';
import { requireLandlord } from '../lib/auth';
import { query, withTransaction } from '../lib/db';
import { conflict, json, parseBody, route } from '../lib/http';
import { appUrl, hashResetToken, newResetToken, requireLocalDriver } from '../lib/password-reset';
import { INVITE_TTL_DAYS, inviteSchema } from '../domain/landlord';

/**
 * The owner asks someone to help run the account: a letting agent, a bookkeeper, a partner.
 * They get an email with a link to choose a password. Asking again replaces the earlier link.
 */
export const handler = route(async (event) => {
  requireLocalDriver();
  const person = requireLandlord(event);
  const { landlordId } = await requireOwner(person);
  const input = parseBody(event, inviteSchema);
  const email = input.email.toLowerCase();
  const base = appUrl();

  const [existing] = await query('select 1 from local_credential where email = $1', [email]);
  // One sign-in works for one landlord, and a tenant's sign-in is a tenant's. Moving a person
  // between the two would change what they can see without them asking.
  if (existing) throw conflict('That email already has an account here. Ask them for another address.');

  const [account] = await query<{ trading_name: string }>('select trading_name from landlord where id = $1', [landlordId]);
  const token = newResetToken();
  const link = `${base}/join?token=${token}`;
  const invite = await withTransaction(async (run) => {
    await run(
      `update landlord_invite set revoked_at = now()
        where landlord_id = $1 and email = $2 and accepted_at is null and revoked_at is null`,
      [landlordId, email],
    );
    const [row] = await run<{ id: string; expires_at: string }>(
      `insert into landlord_invite (landlord_id, email, name, token_hash, invited_by, expires_at)
       values ($1, $2, $3, $4, $5, now() + make_interval(days => $6)) returning id, expires_at::text`,
      [landlordId, email, input.name, hashResetToken(token), person.sub, INVITE_TTL_DAYS],
    );
    await run(
      `insert into notification (recipient_sub, recipient_to, channel, category, kind, urgent, subject, body)
       values ($1, $2, 'email', 'account', 'team_invite', true, $3, $4)`,
      [
        `invite:${row!.id}`,
        email,
        `${account!.trading_name} added you to their rentals`,
        `Hi ${input.name},\n\n${account!.trading_name} has asked you to help manage their rentals: ` +
          `leases, rent, maintenance and applications.\n\nOpen this link within ${INVITE_TTL_DAYS} days to choose ` +
          `a password:\n\n${link}\n\nIf you were not expecting this, ignore it. Nothing happens until you open the link.`,
      ],
    );
    return row!;
  });

  await audit({
    actorSub: person.sub,
    actorRole: 'landlord',
    action: 'landlord.invite_sent',
    entity: 'landlord',
    entityId: landlordId,
    detail: { email, inviteId: invite.id },
  });
  return json(201, { id: invite.id, expiresAt: invite.expires_at });
});
