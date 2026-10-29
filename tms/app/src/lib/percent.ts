/**
 * A percentage as a South African types it. '7,5' is seven and a half: Number('7,5') is NaN,
 * and stripping the comma made it 75. A comma is the decimal point here, never grouping.
 */
export function parsePercent(raw: string): number {
  const trimmed = raw.trim();
  return trimmed === '' ? 0 : Number(trimmed.replace(',', '.'));
}

/** Keeps what was typed to digits and one decimal point, a comma becoming that point. */
export function cleanPercentInput(raw: string): string {
  return raw.replace(/,/g, '.').replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
}
