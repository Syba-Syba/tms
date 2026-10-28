import { z } from 'zod';

/* ------------------------------------------------------------------ *
 * Business days. Notice periods are counted in them; refund deadlines
 * are not. Getting the two mixed up shifts a deadline by about a week.
 * ------------------------------------------------------------------ */

/** Anonymous Gregorian computus. Good Friday and Family Day move every year. */
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

const iso = (date: Date) => date.toISOString().slice(0, 10);
const addDays = (date: Date, days: number) =>
  new Date(date.getTime() + days * 86400000);

/**
 * Holidays that no algorithm can derive: ones created by proclamation. Election days and the
 * extra day gazetted when Christmas fell on a Sunday in 2016 both landed this way. The Act's
 * automatic rule only moves a Sunday holiday to the following Monday; when that Monday is
 * already a holiday it takes a proclamation to add another day, so add it here when it happens.
 */
export const PROCLAIMED_HOLIDAYS = new Set<string>([
  '2016-12-27',
]);

/** South African public holidays. The Public Holidays Act moves a Sunday holiday to the Monday. */
export function publicHolidays(year: number): Set<string> {
  const easter = easterSunday(year);
  const fixed: [number, number][] = [
    [1, 1], [3, 21], [4, 27], [5, 1], [6, 16], [8, 9], [9, 24], [12, 16], [12, 25], [12, 26],
  ];
  const days = fixed.map(([month, day]) => new Date(Date.UTC(year, month - 1, day)));
  days.push(addDays(easter, -2)); // Good Friday
  days.push(addDays(easter, 1)); // Family Day

  const all = new Set<string>();
  for (const day of days) {
    all.add(iso(day));
    if (day.getUTCDay() === 0) all.add(iso(addDays(day, 1)));
  }
  for (const day of PROCLAIMED_HOLIDAYS) {
    if (day.startsWith(String(year))) all.add(day);
  }
  return all;
}

const holidayCache = new Map<number, Set<string>>();
const holidaysFor = (year: number) => {
  let cached = holidayCache.get(year);
  if (!cached) {
    cached = publicHolidays(year);
    holidayCache.set(year, cached);
  }
  return cached;
};

export function isBusinessDay(date: Date): boolean {
  const weekday = date.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  return !holidaysFor(date.getUTCFullYear()).has(iso(date));
}

/** Counting starts the day after notice is given, per the usual reading of "days' notice". */
export function addBusinessDays(from: Date, count: number): Date {
  let cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  let remaining = count;
  while (remaining > 0) {
    cursor = addDays(cursor, 1);
    if (isBusinessDay(cursor)) remaining -= 1;
  }
  return cursor;
}

/* ------------------------------------------------------------------ *
 * Notice
 * ------------------------------------------------------------------ */

/** Consumer Protection Act s14 gives a tenant 20 business days to cancel a fixed term early.
    A lease running to its end date needs no notice period beyond the date itself. */
export const NOTICE_BUSINESS_DAYS = {
  end_of_term: 0,
  early_tenant: 20,
  breach_by_tenant: 20,
  breach_by_landlord: 20,
  mutual: 0,
} as const;

export type TerminationReason = keyof typeof NOTICE_BUSINESS_DAYS;

export const serveNoticeSchema = z.object({
  initiatedBy: z.enum(['tenant', 'landlord', 'mutual']),
  reason: z.enum(['end_of_term', 'early_tenant', 'breach_by_tenant', 'breach_by_landlord', 'mutual']),
  // The tenant's notice is dated the day it is served, whatever the client sends; a landlord
  // may record one received up to a month ago. Omitted, it is today.
  noticeGivenOn: z.coerce.date().optional(),
  // Only supplied when the parties agree a later date than the minimum.
  effectiveOn: z.coerce.date().optional(),
  penaltyCents: z.number().int().min(0).optional(),
});

/** CPA s14(2)(d): a fixed term that runs past its end date carries on month to month, and
    either party ends it on 20 business days' notice. */
export const HOLDOVER_NOTICE_BUSINESS_DAYS = 20;

/** How far past the lease end (or the earliest date, once the lease has run out) an agreed
    or month-to-month end date may go. Anything later is a new lease, not a notice. */
export const LATEST_AFTER_END_DAYS = 31;

const runOut = (noticeGivenOn: Date, leaseEnd: Date) => leaseEnd <= noticeGivenOn;

/** The business days of notice this notice needs. A lease past its end date is month to month,
    so even 'end_of_term' needs the full 20 days then. */
export function noticeBusinessDays(reason: TerminationReason, noticeGivenOn: Date, leaseEnd: Date): number {
  if (reason !== 'mutual' && runOut(noticeGivenOn, leaseEnd)) return HOLDOVER_NOTICE_BUSINESS_DAYS;
  return NOTICE_BUSINESS_DAYS[reason];
}

/** The earliest lawful end date. A lease cannot end before its notice period runs out, and an
    early cancellation cannot run past the lease end date either. */
export function earliestEffectiveDate(
  reason: TerminationReason,
  noticeGivenOn: Date,
  leaseEnd: Date,
): Date {
  // Notice served after the lease has already run out: it is month to month by then, so the
  // notice period runs from the notice date. Ending it that same day was a same-day exit.
  if (runOut(noticeGivenOn, leaseEnd)) {
    return reason === 'mutual' ? noticeGivenOn : addBusinessDays(noticeGivenOn, HOLDOVER_NOTICE_BUSINESS_DAYS);
  }
  if (reason === 'end_of_term') return leaseEnd;
  const afterNotice = addBusinessDays(noticeGivenOn, NOTICE_BUSINESS_DAYS[reason]);
  return afterNotice > leaseEnd ? leaseEnd : afterNotice;
}

/** The latest end date a notice may name. A one-sided notice ends the lease by its end date at
    the latest; only an agreed one, or a lease already month to month, goes a little past it. */
export function latestEffectiveDate(
  reason: TerminationReason,
  noticeGivenOn: Date,
  leaseEnd: Date,
): Date {
  if (reason !== 'mutual' && !runOut(noticeGivenOn, leaseEnd)) return leaseEnd;
  const earliest = earliestEffectiveDate(reason, noticeGivenOn, leaseEnd);
  const from = earliest > leaseEnd ? earliest : leaseEnd;
  return addDays(from, LATEST_AFTER_END_DAYS);
}

/* ------------------------------------------------------------------ *
 * Refund deadlines, Rental Housing Act s5(3)
 * ------------------------------------------------------------------ */

export const REFUND_CALENDAR_DAYS = {
  no_deductions: 7,
  with_deductions: 14,
  no_inspection: 21,
} as const;

export type RefundRule = keyof typeof REFUND_CALENDAR_DAYS;

/**
 * no_deductions   7 days from the lease ending, nothing to repair.
 * with_deductions 14 days from restoration of the dwelling, receipts kept for inspection.
 * no_inspection   21 days from the lease ending. Skipping the outgoing inspection is deemed
 *                 an acknowledgement that there is no damage, so nothing may be deducted.
 */
export function refundDueBy(rule: RefundRule, anchor: Date): Date {
  return addDays(anchor, REFUND_CALENDAR_DAYS[rule]);
}

export function pickRefundRule(input: {
  outgoingInspectionCompleted: boolean;
  deductionCount: number;
}): RefundRule {
  if (!input.outgoingInspectionCompleted) return 'no_inspection';
  return input.deductionCount > 0 ? 'with_deductions' : 'no_deductions';
}

/* ------------------------------------------------------------------ *
 * Reconciliation
 * ------------------------------------------------------------------ */

export interface Reconciliation {
  depositCents: number;
  interestCents: number;
  heldCents: number;
  deductionsCents: number;
  arrearsCents: number;
  penaltyCents: number;
  rentCreditCents: number;
  refundCents: number;
  tenantOwesCents: number;
}

/** Deductions, arrears and any cancellation penalty come off the deposit plus its interest.
    A negative result is a debt owed by the tenant, never a negative refund. */
export function reconcile(input: {
  depositCents: number;
  interestCents: number;
  deductionsCents: number;
  arrearsCents: number;
  penaltyCents: number;
  /** Rent paid for days after the lease ended. The landlord owes it back on top of the deposit. */
  rentCreditCents?: number;
}): Reconciliation {
  const heldCents = input.depositCents + input.interestCents;
  const claimed = input.deductionsCents + input.arrearsCents + input.penaltyCents;
  const net = heldCents + (input.rentCreditCents ?? 0) - claimed;
  return {
    ...input,
    rentCreditCents: input.rentCreditCents ?? 0,
    heldCents,
    refundCents: Math.max(0, net),
    tenantOwesCents: Math.max(0, -net),
  };
}

export const addDeductionSchema = z.object({
  findingId: z.guid().optional(),
  description: z.string().min(3).max(200),
  amountCents: z.number().int().positive(),
  evidenceS3Key: z.string().max(400).optional(),
});

export const settleSchema = z.object({
  // Set when repairs are finished; it anchors the 14 day clock.
  restoredOn: z.coerce.date().optional(),
  refundReference: z.string().max(60).optional(),
});
