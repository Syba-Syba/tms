/**
 * Today on the device's own calendar, as YYYY-MM-DD.
 *
 * toISOString() gives the UTC date, which in South Africa is yesterday for the first two
 * hours of every day. A payment or a notice recorded then carried the wrong legal date.
 */
export function localToday(): string {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

/** A YYYY-MM-DD date moved by whole days, on the calendar rather than the clock. */
export function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  const moved = new Date(Date.UTC(year!, month! - 1, day! + days));
  return moved.toISOString().slice(0, 10);
}
