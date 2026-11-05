import { requireLeaseAccess } from '../lib/access';
import { audit } from '../lib/audit';
import { query, withTransaction } from '../lib/db';
import { badRequest, conflict, forbidden, json, route } from '../lib/http';
import { requireLocalDriver } from '../lib/password-reset';
import { recordInvite, requireInviteAllowance, sendTenantInvite } from '../lib/tenant-invite';

/** Sends, or sends again, the tenant's link to use the app for this lease. */
export const handler = route(async (event) => {
  requireLocalDriver();
  const leaseId = event.pathParameters?.id;
  if (!leaseId) throw badRequest('A lease id is required.');
  const access = await requireLeaseAccess(event, leaseId);
  if (!access.isLandlord) throw forbidden('Only the landlord invites the tenant.');
  // Sending again is one tap, and each tap is an email: the same caps as team invites apply.
  const [target] = await query<{ landlord_id: string; email: string }>(
    `select p.landlord_id, a.email
       from lease l
       join applicant a on a.id = l.applicant_id
       join unit u on u.id = l.unit_id
       join property p on p.id = u.property_id
      where l.id = $1`,
    [leaseId],
  );
  if (target) requireInviteAllowance(target.landlord_id, target.email);
  const outcome = await withTransaction((run) => sendTenantInvite(run, { leaseId, invitedBy: access.person.sub }));
  if (outcome === 'has_account') throw conflict('The tenant already uses the app.');
  if (target) recordInvite(target.landlord_id, target.email);
  await audit({
    actorSub: access.person.sub, actorRole: 'landlord', action: 'lease.tenant_invited', entity: 'lease',
    entityId: leaseId, detail: {},
  });
  return json(201, { ok: true });
});
