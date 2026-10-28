import { z } from 'zod';
import { requireOwner } from '../lib/access';
import { audit } from '../lib/audit';
import { requireLandlord } from '../lib/auth';
import { billingDriver } from '../lib/billing-driver';
import { query } from '../lib/db';
import { badRequest, conflict, json, parseBody, route } from '../lib/http';
import { appUrl } from '../lib/password-reset';
import { checkoutFields, payfastConfig, processUrl } from '../lib/payfast';
import { subscriptionOf } from '../lib/subscription';
import { planById } from '../domain/plans';
import { sastToday } from '../domain/dates';

const schema = z.object({ plan: z.enum(['starter', 'standard', 'pro']) });

/** Where the API is reached from outside, for PayFast's notifications. */
const apiUrl = () => (process.env.PUBLIC_API_URL || appUrl()).replace(/\/+$/, '');

/**
 * Starts paying for a plan. With PayFast, the answer is a signed form the browser posts to
 * PayFast; the subscription only changes when PayFast's notification arrives and checks out.
 */
export const handler = route(async (event) => {
  const person = requireLandlord(event);
  const { landlordId } = await requireOwner(person);
  const { plan: planId } = parseBody(event, schema);
  const plan = planById(planId)!;
  const driver = billingDriver();
  if (driver === 'off') throw conflict('Billing is switched off on this installation.');

  const subscription = await subscriptionOf(landlordId);
  if (subscription.providerToken && subscription.status !== 'cancelled') {
    throw conflict('You already pay monthly. Change the plan instead.');
  }
  const [count] = await query<{ units: string }>(
    'select count(*)::text as units from unit u join property p on p.id = u.property_id where p.landlord_id = $1',
    [landlordId],
  );
  if (Number(count!.units) > plan.maxUnits) {
    throw badRequest(`You have ${count!.units} units. ${plan.name} covers ${plan.maxUnits}.`);
  }

  const [checkout] = await query<{ id: string }>(
    `insert into billing_checkout (landlord_id, plan, amount_cents, created_by) values ($1, $2, $3, $4) returning id`,
    [landlordId, plan.id, plan.priceCents, person.sub],
  );
  await audit({
    actorSub: person.sub, actorRole: 'landlord', action: 'billing.checkout_started', entity: 'landlord',
    entityId: landlordId, detail: { plan: plan.id, checkoutId: checkout!.id },
  });

  if (driver === 'local') return json(201, { kind: 'simulate', checkoutId: checkout!.id });

  const [account] = await query<{ name: string; email: string }>(
    `select coalesce(c.name, l.trading_name) as name, coalesce(c.email, l.email) as email
       from landlord l left join local_credential c on c.sub = $2 where l.id = $1`,
    [landlordId, person.sub],
  );
  const today = sastToday();
  const config = payfastConfig();
  const fields = checkoutFields(config, {
    checkoutId: checkout!.id,
    landlordId,
    amountCents: plan.priceCents,
    itemName: `Threshold ${plan.name}, monthly`,
    firstName: account!.name.split(' ')[0] ?? account!.name,
    email: account!.email,
    returnUrl: `${appUrl()}/settings/billing?paid=1`,
    cancelUrl: `${appUrl()}/settings/billing?cancelled=1`,
    notifyUrl: `${apiUrl()}/billing/notify`,
    // During the trial the monthly charge starts when the trial ends.
    billingDate: subscription.status === 'trialing' && subscription.trialEndsOn > today ? subscription.trialEndsOn : today,
  });
  return json(201, { kind: 'redirect', action: processUrl(config), fields: Object.fromEntries(fields) });
});
