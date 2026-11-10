/**
 * South African business days, the same count the API uses (api/src/domain/termination.ts),
 * so the notice form can work out the limits the server will apply. Keep the two in step:
 * a proclaimed holiday added there belongs here too.
 */

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
const shift = (date: Date, days: number) => new Date(date.getTime() + days * 86_400_000);

const PROCLAIMED_HOLIDAYS = ['2016-12-27'];

const cache = new Map<number, Set<string>>();
function holidays(year: number): Set<string> {
  const cached = cache.get(year);
  if (cached) return cached;
  const easter = easterSunday(year);
  const fixed: [number, number][] = [
    [1, 1], [3, 21], [4, 27], [5, 1], [6, 16], [8, 9], [9, 24], [12, 16], [12, 25], [12, 26],
  ];
  const days = fixed.map(([month, day]) => new Date(Date.UTC(year, month - 1, day)));
  days.push(shift(easter, -2), shift(easter, 1));
  const all = new Set<string>();
  for (const day of days) {
    all.add(iso(day));
    // A Sunday holiday moves to the Monday.
    if (day.getUTCDay() === 0) all.add(iso(shift(day, 1)));
  }
  for (const day of PROCLAIMED_HOLIDAYS) if (day.startsWith(String(year))) all.add(day);
  cache.set(year, all);
  return all;
}

const isBusinessDay = (date: Date) => {
  const weekday = date.getUTCDay();
  return weekday !== 0 && weekday !== 6 && !holidays(date.getUTCFullYear()).has(iso(date));
};

/** `count` business days after a YYYY-MM-DD date, counting from the day after it. */
export function addBusinessDays(from: string, count: number): string {
  const [y, m, d] = from.split('-').map(Number) as [number, number, number];
  let cursor = new Date(Date.UTC(y, m - 1, d));
  let remaining = count;
  while (remaining > 0) {
    cursor = shift(cursor, 1);
    if (isBusinessDay(cursor)) remaining -= 1;
  }
  return iso(cursor);
}

const parse = (day: string) => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
};

/** Business days after `from` up to and including `to`, as the API's businessDaysBetween. */
export function businessDaysBetween(from: string, to: string): number {
  const end = parse(to);
  let cursor = parse(from);
  let count = 0;
  while (cursor < end) {
    cursor = shift(cursor, 1);
    if (isBusinessDay(cursor)) count += 1;
  }
  return count;
}

/** The API's LANDLORD_END_OF_TERM_MAX_BUSINESS_DAYS (CPA s14(2)(c): 40 to 80 before expiry). */
export const LANDLORD_END_OF_TERM_MAX_BUSINESS_DAYS = 80;

/** The first day a landlord's end-of-term notice can be served, as the API's
    landlordEndOfTermServableFrom: 80 business days or fewer before the end date. */
export function landlordEndOfTermServableFrom(leaseEnd: string): string {
  let day = leaseEnd;
  const before = (value: string) => iso(shift(parse(value), -1));
  // Walk back while the day before is still inside the window.
  while (businessDaysBetween(before(day), leaseEnd) <= LANDLORD_END_OF_TERM_MAX_BUSINESS_DAYS) day = before(day);
  return day;
}
