import { requireLeaseAccess } from '../lib/access';
import { arrearsView } from '../lib/arrears';
import { badRequest, json, route } from '../lib/http';
import { sastToday } from '../domain/dates';

/** Where a lease stands on the arrears ladder. Both parties see it: the tenant sees the same
    reminders and letter they were sent. */
export const handler = route(async (event) => {
  const leaseId = event.pathParameters?.id;
  if (!leaseId) throw badRequest('A lease id is required.');
  const access = await requireLeaseAccess(event, leaseId);
  const view = await arrearsView(leaseId, sastToday());
  // The letter button and the pause control are the landlord's; a tenant gets the record only.
  return json(200, access.isLandlord ? view : { ...view, letter: null });
});
