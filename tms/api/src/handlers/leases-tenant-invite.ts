import { requireLeaseAccess } from '../lib/access';
import { audit } from '../lib/audit';
import { withTransaction } from '../lib/db';
import { badRequest, conflict, forbidden, json, route } from '../lib/http';
import { requireLocalDriver } from '../lib/password-reset';
import { sendTenantInvite } from '../lib/tenant-invite';

/** Sends, or sends again, the tenant's link to use the app for this lease. */
export const handler = route(async (event) => {
  requireLocalDriver();
  const leaseId = event.pathParameters?.id;
  if (!leaseId) throw badRequest('A lease id is required.');
  const access = await requireLeaseAccess(event, leaseId);
  if (!access.isLandlord) throw forbidden('Only the landlord invites the tenant.');
  const outcome = await withTransaction((run) => sendTenantInvite(run, { leaseId, invitedBy: access.person.sub }));
  if (outcome === 'has_account') throw conflict('The tenant already uses the app.');
  await audit({
    actorSub: access.person.sub, actorRole: 'landlord', action: 'lease.tenant_invited', entity: 'lease',
    entityId: leaseId, detail: {},
  });
  return json(201, { ok: true });
});
