import { z } from 'zod';
import { query } from '../lib/db';
import { json, notFound, parseBody, route } from '../lib/http';
import { hashResetToken, requireLocalDriver } from '../lib/password-reset';

const schema = z.object({ token: z.string().min(20).max(200) });

/** What the join page shows before anyone types a password: who invited them, and as whom. */
export const handler = route(async (event) => {
  requireLocalDriver();
  const { token } = parseBody(event, schema);
  const [invite] = await query<{ name: string; email: string; trading_name: string }>(
    `select i.name, i.email, l.trading_name from landlord_invite i join landlord l on l.id = i.landlord_id
      where i.token_hash = $1 and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()`,
    [hashResetToken(token)],
  );
  if (!invite) throw notFound('Invite');
  return json(200, { name: invite.name, email: invite.email, landlord: invite.trading_name });
});
