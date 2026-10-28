import { z } from 'zod';

export const EXPENSE_CATEGORIES = [
  'rates', 'levies', 'insurance', 'repairs', 'utilities', 'bond_interest',
  'agent_fees', 'bank_charges', 'legal', 'advertising', 'other',
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const expenseSchema = z.object({
  propertyId: z.guid().nullable().optional(),
  unitId: z.guid().nullable().optional(),
  category: z.enum(EXPENSE_CATEGORIES),
  description: z.string().trim().min(2).max(200),
  amountCents: z.number().int().positive().max(1_000_000_000),
  incurredOn: z.iso.date(),
});

export const slipSchema = z.object({
  contentType: z.enum(['image/jpeg', 'image/png', 'application/pdf']),
  sizeBytes: z.number().int().positive().max(10 * 1024 * 1024, 'Files must be under 10 MB.'),
});

/**
 * The South African tax year runs 1 March to the end of February, named for the year it ends
 * in: the 2027 tax year is 1 March 2026 to 28 February 2027.
 */
export function taxYear(endingIn: number): { from: string; to: string } {
  const lastDay = new Date(Date.UTC(endingIn, 2, 0)).getUTCDate();
  return { from: `${endingIn - 1}-03-01`, to: `${endingIn}-02-${String(lastDay).padStart(2, '0')}` };
}

/** The tax year a date falls in. */
export const taxYearOf = (iso: string) => {
  const [year, month] = iso.split('-').map(Number) as [number, number];
  return month >= 3 ? year + 1 : year;
};
