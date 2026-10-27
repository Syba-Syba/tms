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
