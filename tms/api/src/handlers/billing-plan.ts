import { z } from 'zod';
import { requireOwner } from '../lib/access';
import { audit } from '../lib/audit';
import { requireLandlord } from '../lib/auth';
import { billingDriver } from '../lib/billing-driver';
import { query } from '../lib/db';
import { badRequest, conflict, json, parseBody, route } from '../lib/http';
import { cancelSubscription, payfastConfig, updateSubscriptionAmount } from '../lib/payfast';
import { subscriptionOf } from '../lib/subscription';
import { planById } from '../domain/plans';

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('change'), plan: z.enum(['starter', 'standard', 'pro']) }),
  z.object({ action: z.literal('cancel') }),
]);

/**
 * Changes the plan of a running monthly payment, from the next charge on, or cancels it. A
 * cancelled plan runs to the end of the month already paid for.
 */
export const handler = route(async (event) => {
  const person = requireLandlord(event);
  const { landlordId } = await requireOwner(person);
  const input = parseBody(event, schema);
  const driver = billingDriver();
  const subscription = await subscriptionOf(landlordId);
  if (!subscription.providerToken || subscription.status === 'cancelled') throw conflict('There is no monthly payment running.');

  if (input.action === 'cancel') {
    if (driver === 'payfast') await cancelSubscription(payfastConfig(), subscription.providerToken);
    await query(`update subscription set status = 'cancelled', updated_at = now() where landlord_id = $1`, [landlordId]);
    await audit({ actorSub: person.sub, actorRole: 'landlord', action: 'billing.cancelled', entity: 'landlord', entityId: landlordId, detail: {} });
    return json(200, { status: 'cancelled', paidUntil: subscription.currentPeriodEnd });
  }

  const plan = planById(input.plan)!;
  if (plan.id === subscription.plan) throw conflict(`You are on ${plan.name} already.`);
  const [count] = await query<{ units: string }>(
    'select count(*)::text as units from unit u join property p on p.id = u.property_id where p.landlord_id = $1',
    [landlordId],
  );
  if (Number(count!.units) > plan.maxUnits) {
    throw badRequest(`You have ${count!.units} units. ${plan.name} covers ${plan.maxUnits}. Remove units first.`);
  }
  if (driver === 'payfast') await updateSubscriptionAmount(payfastConfig(), subscription.providerToken, plan.priceCents);
  await query('update subscription set plan = $2, updated_at = now() where landlord_id = $1', [landlordId, plan.id]);
  await audit({
    actorSub: person.sub, actorRole: 'landlord', action: 'billing.plan_changed', entity: 'landlord', entityId: landlordId,
    detail: { from: subscription.plan, to: plan.id },
  });
  return json(200, { plan: plan.id });
});
