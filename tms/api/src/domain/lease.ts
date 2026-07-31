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
  otpVerified: z.boolean(),
  pdfSha256: z.string().length(64),
});

export function leaseEndDate(start: Date, months: number) {
  const end = new Date(start);
  end.setMonth(end.getMonth() + months);
  end.setDate(end.getDate() - 1);
  return end;
}

/** Rounded to the cent so the escalated figure on year two always matches the printed lease. */
export const escalatedRent = (rentCents: number, escalationPct: number) =>
  Math.round(rentCents * (1 + escalationPct / 100));
