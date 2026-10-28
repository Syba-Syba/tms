import { z } from 'zod';

/** The part of a listings link after /apply?landlord=. Lowercase, digits and hyphens. */
export const SLUG = /^[a-z0-9][a-z0-9-]{2,39}$/;

export function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 34)
    .replace(/-+$/, '');
  return base.length >= 3 ? base : `landlord-${base || 'x'}`.slice(0, 34);
}

const phone = z.string().trim().regex(/^\+?[0-9 ]{9,16}$/, 'Use a phone number like 082 123 4567.');

/** Bank details go in as a set: half an account is worse than none on an invoice. */
const bank = z.object({
  name: z.string().trim().min(2).max(60),
  holder: z.string().trim().min(2).max(120),
  accountNumber: z.string().trim().regex(/^[0-9]{6,16}$/, 'Account numbers are 6 to 16 digits.'),
  branchCode: z.string().trim().regex(/^[0-9]{6}$/, 'Branch codes are 6 digits.'),
});

export const updateAccountSchema = z
  .object({
    tradingName: z.string().trim().min(2).max(120),
    email: z.string().trim().email().max(254),
    phone,
    registrationNo: z.string().trim().max(40).nullable(),
    slug: z.string().trim().toLowerCase().regex(SLUG, 'Use 3 to 40 lowercase letters, digits or hyphens.'),
    bank,
  })
  .partial()
  .refine((input) => Object.keys(input).length > 0, 'Nothing to change.');

export const landlordSignUpSchema = z.object({
  tradingName: z.string().trim().min(2).max(120),
  phone,
});

export const inviteSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254),
});

export const INVITE_TTL_DAYS = 7;
