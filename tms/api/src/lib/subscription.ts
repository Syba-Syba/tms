import { query } from './db';
import { billingDriver } from './billing-driver';
import { ApiError } from './http';
import { canWrite, PLANS, planById, standing, TRIAL_MAX_UNITS, type PlanId, type Standing, type SubscriptionState } from '../domain/plans';
import { sastToday } from '../domain/dates';

type Run = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

export interface Subscription extends SubscriptionState {
  landlordId: string;
  plan: PlanId | null;
  provider: string | null;
  providerToken: string | null;
}

export async function subscriptionOf(landlordId: string, run: Run = query): Promise<Subscription> {
  const [row] = await run<{
    plan: PlanId | null; status: Subscription['status']; trial_ends_on: string; current_period_end: string | null;
    provider: string | null; provider_token: string | null;
  }>(
    `select plan, status, trial_ends_on::text, current_period_end::text, provider, provider_token
       from subscription where landlord_id = $1`,
    [landlordId],
  );
  // Every landlord row gets one from a trigger; this only covers a race with the insert.
  if (!row) return { landlordId, plan: null, status: 'trialing', trialEndsOn: sastToday(), currentPeriodEnd: null, provider: null, providerToken: null };
  return {
    landlordId,
    plan: row.plan,
    status: row.status,
    trialEndsOn: row.trial_ends_on,
    currentPeriodEnd: row.current_period_end,
    provider: row.provider,
    providerToken: row.provider_token,
  };
}

/** With billing off, every account stands as paid up. */
export const standingOf = async (landlordId: string): Promise<Standing> =>
  billingDriver() === 'off' ? 'active' : standing(await subscriptionOf(landlordId), sastToday());

/** The most units the account may hold right now. */
export function unitAllowance(subscription: Subscription, value: Standing): number {
  if (billingDriver() === 'off') return Number.POSITIVE_INFINITY;
  if (value === 'trial') return TRIAL_MAX_UNITS;
  return planById(subscription.plan)?.maxUnits ?? 0;
}

export const writable = async (landlordId: string) => canWrite(await standingOf(landlordId));

/** One month on from a date, clamped to the month's last day (31 January runs to 28 February). */
export function addMonth(iso: string): string {
  const [y, m, d] = [Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), Number(iso.slice(8, 10))];
  const next = new Date(Date.UTC(y, m, 1));
  const last = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(d, last));
  return next.toISOString().slice(0, 10);
}

/**
 * Refuses units past what the plan covers. During the trial that is the largest plan; with
 * billing off there is no limit.
 */
export async function assertUnitRoom(landlordId: string, adding: number): Promise<void> {
  if (adding <= 0) return;
  const subscription = await subscriptionOf(landlordId);
  const allowance = unitAllowance(subscription, await standingOf(landlordId));
  if (!Number.isFinite(allowance)) return;
  const [count] = await query<{ units: string }>(
    'select count(*)::text as units from unit u join property p on p.id = u.property_id where p.landlord_id = $1',
    [landlordId],
  );
  const units = Number(count!.units);
  if (units + adding > allowance) {
    const next = PLANS.find((plan) => plan.maxUnits >= units + adding);
    throw new ApiError(
      402,
      'plan_limit',
      next
        ? `Your plan covers ${allowance} units and you have ${units}. Move to ${next.name} to add more.`
        : `That would make ${units + adding} units, more than any plan covers. Get in touch for a larger plan.`,
    );
  }
}
