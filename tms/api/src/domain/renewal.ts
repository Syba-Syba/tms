import { z } from 'zod';
import { rentForPeriod } from './money';

/* ------------------------------------------------------------------ *
 * Pro-rata
 * ------------------------------------------------------------------ */

const utc = (year: number, month: number, day: number) => new Date(Date.UTC(year, month, day));
const startOfMonth = (date: Date) => utc(date.getUTCFullYear(), date.getUTCMonth(), 1);
const endOfMonth = (date: Date) => utc(date.getUTCFullYear(), date.getUTCMonth() + 1, 0);
const dayCount = (from: Date, to: Date) =>
  Math.round((to.getTime() - from.getTime()) / 86400000) + 1;

export interface BillingWindow {
  from: Date;
  to: Date;
  days: number;
  daysInMonth: number;
  full: boolean;
}

/**
 * The slice of a billing month a tenant actually occupies. A lease starting on the 15th used to
 * produce no invoice at all, because the run compared the start date against the 1st. A lease
 * ending on the 15th was billed the whole month, and that overcharge came straight back off the
 * deposit as arrears.
 */
export function billingWindow(input: {
  periodStart: Date;
  leaseStart: Date;
  leaseEnd: Date;
  terminationEffectiveOn?: Date | null;
}): BillingWindow | null {
  const monthStart = startOfMonth(input.periodStart);
  const monthEnd = endOfMonth(input.periodStart);
  const lastDay = input.terminationEffectiveOn
    ? new Date(Math.min(input.leaseEnd.getTime(), input.terminationEffectiveOn.getTime()))
    : input.leaseEnd;

  const from = input.leaseStart > monthStart ? input.leaseStart : monthStart;
  const to = lastDay < monthEnd ? lastDay : monthEnd;
  if (to < from) return null;

  const daysInMonth = dayCount(monthStart, monthEnd);
  const days = dayCount(from, to);
  return { from, to, days, daysInMonth, full: days === daysInMonth };
}

/** Charged on actual days in that month, so February is not quietly cheaper per day. */
export const proRataCents = (monthlyCents: number, window: BillingWindow) =>
  window.full ? monthlyCents : Math.round((monthlyCents * window.days) / window.daysInMonth);

export function rentForWindow(input: {
  baseRentCents: number;
  escalationPct: number;
  leaseStart: Date;
  window: BillingWindow;
}): number {
  const { window } = input;
  const monthly = rentForPeriod(input.baseRentCents, input.escalationPct, input.leaseStart, startOfMonth(window.from));
  // A lease that started mid-month escalates mid-month. Rating the whole anniversary month on
  // its 1st billed it all at the old rent, so the days from the anniversary on are charged at
  // the new rent instead, on actual days as any part month is.
  const anniversary = new Date(input.leaseStart);
  anniversary.setUTCFullYear(window.from.getUTCFullYear());
  if (anniversary.getUTCFullYear() > input.leaseStart.getUTCFullYear() && anniversary > window.from && anniversary <= window.to) {
    const escalated = rentForPeriod(input.baseRentCents, input.escalationPct, input.leaseStart, anniversary);
    const oldDays = dayCount(window.from, anniversary) - 1;
    return Math.round((monthly * oldDays + escalated * (window.days - oldDays)) / window.daysInMonth);
  }
  return proRataCents(monthly, window);
}

export function describeWindow(window: BillingWindow): string {
  const day = (date: Date) => date.toISOString().slice(0, 10);
  return window.full ? '' : ` (${day(window.from)} to ${day(window.to)}, ${window.days} days)`;
}

/* ------------------------------------------------------------------ *
 * Renewal terms
 * ------------------------------------------------------------------ */

export const DEFAULT_TERM_MONTHS = 12;
export const DEFAULT_RESPOND_DAYS = 14;

export interface RenewalTerms {
  newStartDate: Date;
  newEndDate: Date;
  newRentCents: number;
  depositTopUpCents: number;
  respondBy: Date;
}

const addMonths = (date: Date, months: number) => {
  const result = utc(date.getUTCFullYear(), date.getUTCMonth() + months, date.getUTCDate());
  // 31 January plus one month is 28 February, not 3 March.
  if (result.getUTCDate() !== date.getUTCDate()) return utc(result.getUTCFullYear(), result.getUTCMonth(), 0);
  return result;
};

/**
 * The renewal starts the day after the current lease ends, so there is no gap and no overlap.
 * Rent carries the agreed escalation. The deposit is topped up to match the new rent rather
 * than refunded and recollected, because the tenant is not moving and the interest keeps running.
 *
 * A tenant holding over (the end date has passed) cannot start a lease in the past: the offer
 * had expired the moment it was made. The renewal then starts on the first of the month once
 * the full response time has run, and the tenant carries on month to month until then.
 */
export function renewalTerms(input: {
  currentEndDate: Date;
  currentRentCents: number;
  escalationPct: number;
  termMonths?: number;
  depositHeldCents: number;
  offeredOn: Date;
  respondDays?: number;
}): RenewalTerms {
  const termMonths = input.termMonths ?? DEFAULT_TERM_MONTHS;
  const offeredDay = utc(input.offeredOn.getUTCFullYear(), input.offeredOn.getUTCMonth(), input.offeredOn.getUTCDate());
  const respondFull = new Date(offeredDay.getTime() + (input.respondDays ?? DEFAULT_RESPOND_DAYS) * 86400000);
  const dayAfterEnd = new Date(input.currentEndDate.getTime() + 86400000);
  const holdingOver = dayAfterEnd <= offeredDay;

  const newStartDate = holdingOver
    ? respondFull.getUTCDate() === 1
      ? respondFull
      : utc(respondFull.getUTCFullYear(), respondFull.getUTCMonth() + 1, 1)
    : dayAfterEnd;
  const newEndDate = new Date(addMonths(newStartDate, termMonths).getTime() - 86400000);
  const newRentCents = Math.round(input.currentRentCents * (1 + input.escalationPct / 100));

  const respondBy = new Date(Math.min(respondFull.getTime(), newStartDate.getTime()));

  return {
    newStartDate,
    newEndDate,
    newRentCents,
    // Never negative: a deposit is not refunded part way through a tenancy.
    depositTopUpCents: Math.max(0, newRentCents - input.depositHeldCents),
    respondBy,
  };
}

export const offerRenewalSchema = z.object({
  termMonths: z.number().int().min(1).max(60).optional(),
  escalationPct: z.number().min(0).max(50).optional(),
  respondDays: z.number().int().min(1).max(90).optional(),
  newRentCents: z.number().int().positive().optional(),
});

export const decideRenewalSchema = z.object({
  decision: z.enum(['accept', 'decline']),
  note: z.string().max(500).optional(),
});
