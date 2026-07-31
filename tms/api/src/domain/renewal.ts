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
  const monthly = rentForPeriod(
    input.baseRentCents,
    input.escalationPct,
    input.leaseStart,
    startOfMonth(input.window.from),
  );
  return proRataCents(monthly, input.window);
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
  const newStartDate = new Date(input.currentEndDate.getTime() + 86400000);
  const newEndDate = new Date(addMonths(newStartDate, termMonths).getTime() - 86400000);
  const newRentCents = Math.round(input.currentRentCents * (1 + input.escalationPct / 100));

  const respondBy = new Date(
    Math.min(
      input.offeredOn.getTime() + (input.respondDays ?? DEFAULT_RESPOND_DAYS) * 86400000,
      newStartDate.getTime(),
    ),
  );

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
