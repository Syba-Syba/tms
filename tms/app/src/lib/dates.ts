const SAST_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Johannesburg',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Today in Johannesburg, as YYYY-MM-DD.
 *
 * Legal dates (notice, payment received) are checked by the server against the SAST date.
 * The device's own calendar is wrong on a laptop set to UTC or abroad, and toISOString()
 * gives the UTC date, which here is yesterday for the first two hours of every day.
 */
export function localToday(now: Date = new Date()): string {
  const parts = SAST_DAY.formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** A YYYY-MM-DD date moved by whole days, on the calendar rather than the clock. */
export function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  const moved = new Date(Date.UTC(year!, month! - 1, day! + days));
  return moved.toISOString().slice(0, 10);
}
