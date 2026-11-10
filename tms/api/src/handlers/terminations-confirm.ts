import { requireLeaseAccessVia } from '../lib/access';
import { audit } from '../lib/audit';
import { withTransaction } from '../lib/db';
import { badRequest, conflict, forbidden, json, notFound, route } from '../lib/http';
import { notify } from '../lib/notify';
import { leaseParties } from '../lib/lease-parties';

/**
 * The tenant confirms a notice the landlord recorded for them: a mutual one, or the tenant's own
 * notice (with any penalty on it) entered by the landlord. Until then it is the landlord's word alone, so the
 * deposit cannot be settled and the tenant may withdraw it. Only the tenant confirms.
 */
export const handler = route(async (event) => {
  const terminationId = event.pathParameters?.id;
  if (!terminationId) throw badRequest('A termination id is required.');
  const access = await requireLeaseAccessVia(
    event,
    'select lease_id from termination where id = $1',
    [terminationId],
    'Termination',
  );
  if (!access.isTenant || access.isLandlord) throw forbidden('Only the tenant confirms this notice.');

  const result = await withTransaction(async (run) => {
    const [termination] = await run<{
      lease_id: string; status: string; effective_on: string; needs: boolean; confirmed: boolean;
    }>(
      `select lease_id, status, effective_on::text, needs_tenant_confirmation as needs,
              tenant_confirmed_at is not null as confirmed
         from termination where id = $1 for update`,
      [terminationId],
    );
    if (!termination) throw notFound('Termination');
    if (termination.status === 'withdrawn') throw conflict('This notice was withdrawn.');
    if (!termination.needs) throw conflict('This notice does not need your confirmation.');
    if (termination.confirmed) throw conflict('You have already confirmed this notice.');
    await run('update termination set tenant_confirmed_at = now() where id = $1', [terminationId]);
    return { leaseId: termination.lease_id, effectiveOn: termination.effective_on };
  });

  const parties = await leaseParties(result.leaseId);
  if (parties?.landlordSub) {
    await notify({
      leaseId: result.leaseId,
      to: { sub: parties.landlordSub, email: parties.landlordEmail },
      kind: 'notice_confirmed',
      dedupeKey: `notice_confirmed:${terminationId}`,
      data: { unit: parties.unit, effectiveOn: result.effectiveOn },
    });
  }

  await audit({
    actorSub: access.person.sub,
    actorRole: 'tenant',
    action: 'termination.confirmed',
    entity: 'termination',
    entityId: terminationId,
    detail: { effectiveOn: result.effectiveOn },
  });

  return json(200, { id: terminationId, confirmed: true });
});
