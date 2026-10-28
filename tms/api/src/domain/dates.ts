/**
 * Calendar dates for a system whose law, leases and deadlines all run on South African time.
 *
 * Dates in this codebase are plain 'YYYY-MM-DD' strings in the database and UTC-midnight Date
 * objects in memory. "Today" was being computed three different ways (toISOString, which is
 * UTC; `current_date` in SQL, which is the database server's zone; and `new Date()` compared
 * against a date), so between 00:00 and 02:00 SAST a notice, a payment or a settlement was
 * dated the day before. South Africa has no daylight saving, so the offset is a constant.
 */
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

/** Today's calendar date in Johannesburg, as 'YYYY-MM-DD'. */
export function sastToday(now: Date = new Date()): string {
  return new Date(now.getTime() + SAST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The first day of the current month in Johannesburg, as 'YYYY-MM-DD'. */
export const sastMonthStart = (now: Date = new Date()) => `${sastToday(now).slice(0, 7)}-01`;

/** The day of the month in Johannesburg, 1 to 31. */
export const sastDayOfMonth = (now: Date = new Date()) => Number(sastToday(now).slice(8, 10));

/** A 'YYYY-MM-DD' string as the UTC-midnight Date the domain functions compare. */
export const dateFromIso = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`);

/** A Date (UTC midnight, or any instant) as 'YYYY-MM-DD'. */
export const isoDate = (date: Date) => date.toISOString().slice(0, 10);

export const addDaysIso = (iso: string, days: number) =>
  isoDate(new Date(dateFromIso(iso).getTime() + days * DAY_MS));

/** The first day of the month after the one containing `iso`. */
export function nextMonthStart(iso: string): string {
  const date = dateFromIso(iso);
  return isoDate(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)));
}
