import { z } from 'zod';
import { query } from '../lib/db';
import { json, notFound, parseBody, route } from '../lib/http';
import { hashResetToken, requireLocalDriver } from '../lib/password-reset';

const schema = z.object({ token: z.string().min(20).max(200) });

/**
 * What the join page shows before anyone types a password: who sent the link and as what the
 * person joins. A tenant whose email already has an account signs in with it instead of
 * choosing a new password, so the page says which it needs.
 */
export const handler = route(async (event) => {
  requireLocalDriver();
  const hash = hashResetToken(parseBody(event, schema).token);
  const [agent] = await query<{ name: string; email: string; trading_name: string }>(
    `select i.name, i.email, l.trading_name from landlord_invite i join landlord l on l.id = i.landlord_id
      where i.token_hash = $1 and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()`,
    [hash],
  );
  if (agent) {
    return json(200, { kind: 'agent', name: agent.name, email: agent.email, landlord: agent.trading_name, hasAccount: false });
  }
  const [tenant] = await query<{ name: string; email: string; trading_name: string; unit: string; has_account: boolean }>(
    `select a.first_name || ' ' || a.last_name as name, i.email, ll.trading_name, p.name || ' ' || u.code as unit,
            exists (select 1 from local_credential c where c.email = i.email) as has_account
       from tenant_invite i
       join lease l on l.id = i.lease_id
       join applicant a on a.id = i.applicant_id
       join unit u on u.id = l.unit_id
       join property p on p.id = u.property_id
       join landlord ll on ll.id = p.landlord_id
      where i.token_hash = $1 and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()`,
    [hash],
  );
  if (!tenant) throw notFound('Invite');
  return json(200, {
    kind: 'tenant', name: tenant.name, email: tenant.email, landlord: tenant.trading_name, unit: tenant.unit,
    hasAccount: tenant.has_account,
  });
});
