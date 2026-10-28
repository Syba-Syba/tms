import { membershipOf } from '../lib/access';
import { requireLandlord } from '../lib/auth';
import { billingDriver } from '../lib/billing-driver';
import { query } from '../lib/db';
import { json, route } from '../lib/http';
import { standingOf, subscriptionOf, unitAllowance } from '../lib/subscription';
import { GRACE_DAYS, PLANS, planFor } from '../domain/plans';

/** Where the landlord account stands: trial, plan, the paid-up date, and what each plan costs. */
export const handler = route(async (event) => {
  const person = requireLandlord(event);
  const { landlordId, role } = await membershipOf(person);
  const subscription = await subscriptionOf(landlordId);
  const standing = await standingOf(landlordId);
  const [count] = await query<{ units: string }>(
    'select count(*)::text as units from unit u join property p on p.id = u.property_id where p.landlord_id = $1',
    [landlordId],
  );
  const units = Number(count!.units);
  const allowance = unitAllowance(subscription, standing);
  return json(200, {
    driver: billingDriver(),
    standing,
    status: subscription.status,
    plan: subscription.plan,
    trialEndsOn: subscription.trialEndsOn,
    paidUntil: subscription.currentPeriodEnd,
    graceDays: GRACE_DAYS,
    hasRecurring: Boolean(subscription.providerToken),
    units,
    allowance: Number.isFinite(allowance) ? allowance : null,
    recommended: planFor(units)?.id ?? null,
    plans: PLANS.map((plan) => ({ ...plan })),
    isOwner: role === 'owner',
  });
});
