import { parseCurrencyInput } from '@hlonie/toolbox/ui';

/** Monthly income in cents as an applicant types it: '25 000', '25,000', 'R25000.00'.
    Null when it is not an amount, so the form can say so before the API refuses it. */
export function incomeCents(raw: string): number | null {
  const cents = parseCurrencyInput(raw);
  return cents === null || cents < 0 ? null : cents;
}
