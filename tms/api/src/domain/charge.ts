import { z } from 'zod';

export const chargeSchema = z.object({
  // The month the charge belongs to, as 2026-11.
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Pick the month.'),
  kind: z.enum(['utility', 'other']),
  description: z.string().trim().min(3, 'Say what it is for.').max(120),
  amountCents: z.number().int().positive('The amount must be more than zero.').max(10_000_000),
});

/** How far ahead a charge can be added: water estimated for the next few months. */
export const MONTHS_AHEAD = 3;

export const monthsBetween = (fromMonth: string, toMonth: string) =>
  (Number(toMonth.slice(0, 4)) - Number(fromMonth.slice(0, 4))) * 12 + (Number(toMonth.slice(5, 7)) - Number(fromMonth.slice(5, 7)));

/** paid, part paid or issued, from what has been paid against the total. */
export const invoiceStatus = (paidCents: number, totalCents: number) =>
  totalCents <= 0 ? 'void' : paidCents >= totalCents ? 'paid' : paidCents > 0 ? 'part_paid' : 'issued';
