import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireOwner } from '../lib/access';
import { requireLandlord } from '../lib/auth';
import { applyPaymentNotice } from '../lib/billing-events';
import { billingDriver } from '../lib/billing-driver';
import { query } from '../lib/db';
import { badRequest, json, notFound, parseBody, route } from '../lib/http';
import { subscriptionOf } from '../lib/subscription';
import { planById } from '../domain/plans';

const schema = z.object({
  checkoutId: z.guid().optional(),
  outcome: z.enum(['paid', 'failed', 'cancelled']),
});

/**
 * Development only: plays the part of the payment provider, through the same code a real
 * notification takes, so the screens and the rules can be tried without a merchant account.
 * With a checkout id it pays the first month; without one it renews, fails or cancels the
 * running payment.
 */
export const handler = route(async (event) => {
  if (billingDriver() !== 'local') throw badRequest('Simulated payments only run with BILLING_DRIVER=local.');
  const person = requireLandlord(event);
  const { landlordId } = await requireOwner(person);
  const input = parseBody(event, schema);
  const subscription = await subscriptionOf(landlordId);

  let amountCents: number | null = null;
  if (input.checkoutId) {
    const [checkout] = await query<{ amount_cents: string }>(
      'select amount_cents::text from billing_checkout where id = $1 and landlord_id = $2',
      [input.checkoutId, landlordId],
    );
    if (!checkout) throw notFound('Checkout');
    amountCents = Number(checkout.amount_cents);
  } else {
    if (!subscription.providerToken) throw badRequest('There is no monthly payment to renew.');
    amountCents = planById(subscription.plan)?.priceCents ?? null;
  }

  const result = await applyPaymentNotice({
    provider: 'local',
    externalId: randomUUID(),
    checkoutId: input.checkoutId ?? null,
    token: subscription.providerToken ?? `local-${landlordId}`,
    outcome: input.outcome,
    amountCents,
    payload: { simulated: 'true', outcome: input.outcome },
  });
  return json(200, result);
});
