import { z } from 'zod';

export const generateLeaseSchema = z.object({
  startDate: z.coerce.date(),
  months: z.number().int().min(1).max(24).default(12),
  escalationPct: z.number().min(0).max(20).default(8),
  depositCents: z.number().int().nonnegative().optional(),
});

export const signLeaseSchema = z.object({
  party: z.enum(['tenant', 'landlord']),
  signatureBase64: z.string().min(100, 'Signature image is missing.'),
  // Kept for the column it is stored in. No PIN is issued anywhere, so the server never
  // required it to be true; the client used to assert it anyway, which proved nothing.
  otpVerified: z.boolean().optional().default(false),
  pdfSha256: z.string().length(64),
});

/**
 * The last day of a term: the day before the same day-of-month `months` later. Worked in UTC,
 * because date-only values parse as UTC midnight and local setMonth shifted them by the
 * machine's offset. Month overflow is clamped (31 Jan + 1 month is 28 Feb, not 3 March), the
 * same rule renewals use, so a term ending in February no longer bills days in March.
 */
export function leaseEndDate(start: Date, months: number) {
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth();
  const day = start.getUTCDate();
  let next = new Date(Date.UTC(year, month + months, day));
  if (next.getUTCDate() !== day) next = new Date(Date.UTC(year, month + months + 1, 0));
  return new Date(next.getTime() - 86400000);
}

/** Rounded to the cent so the escalated figure on year two always matches the printed lease. */
export const escalatedRent = (rentCents: number, escalationPct: number) =>
  Math.round(rentCents * (1 + escalationPct / 100));
