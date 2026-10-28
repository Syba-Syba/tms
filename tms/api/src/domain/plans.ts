/**
 * What a landlord pays, by how many units they run. Prices are monthly, in cents, VAT
 * included. Change them here: the billing screen, the checkout and the unit limits all read
 * this list.
 */
export const PLANS = [
  { id: 'starter', name: 'Starter', maxUnits: 5, priceCents: 19_900 },
  { id: 'standard', name: 'Standard', maxUnits: 20, priceCents: 44_900 },
  { id: 'pro', name: 'Pro', maxUnits: 60, priceCents: 99_900 },
] as const;

export type PlanId = (typeof PLANS)[number]['id'];

export const TRIAL_DAYS = 30;
/** Days after a missed payment before the account goes read-only. */
export const GRACE_DAYS = 7;
/** During the trial, everything up to the largest plan. */
export const TRIAL_MAX_UNITS = PLANS[2].maxUnits;

export const planById = (id: string | null | undefined) => PLANS.find((plan) => plan.id === id) ?? null;

/** The smallest plan that covers this many units, or null past the largest. */
export const planFor = (units: number) => PLANS.find((plan) => units <= plan.maxUnits) ?? null;

export type Standing = 'trial' | 'active' | 'past_due' | 'cancelling' | 'lapsed';

export interface SubscriptionState {
  status: 'trialing' | 'active' | 'past_due' | 'cancelled';
  trialEndsOn: string;
  currentPeriodEnd: string | null;
}

const addDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Whether the landlord can still make changes today, and in what state. Paid time is never cut
 * short: a cancelled plan runs to the end of the month paid for, and a missed payment gets a
 * week's grace before the account goes read-only.
 */
export function standing(state: SubscriptionState, today: string): Standing {
  if (state.status === 'trialing') return today <= state.trialEndsOn ? 'trial' : 'lapsed';
  const end = state.currentPeriodEnd;
  if (state.status === 'active') return !end || today <= addDays(end, GRACE_DAYS) ? 'active' : 'lapsed';
  if (state.status === 'past_due') return end && today <= addDays(end, GRACE_DAYS) ? 'past_due' : 'lapsed';
  return end && today <= end ? 'cancelling' : 'lapsed';
}

export const canWrite = (value: Standing) => value !== 'lapsed';
