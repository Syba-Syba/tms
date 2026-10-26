import { z } from 'zod';

const luhnValid = (digits: string) => {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = Number(digits[i]);
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
};

export const saIdNumber = z
  .string()
  .transform((value) => value.replace(/\D/g, ''))
  .refine((value) => value.length === 13 && luhnValid(value), 'Enter a valid 13 digit ID number.');

export const saPhone = z
  .string()
  .transform((value) => {
    const digits = value.replace(/\D/g, '');
    if (digits.length === 10 && digits.startsWith('0')) return `+27${digits.slice(1)}`;
    if (digits.length === 11 && digits.startsWith('27')) return `+${digits}`;
    return value;
  })
  .refine((value) => /^\+27\d{9}$/.test(value), 'Enter a valid South African mobile number.');

export const createApplicationSchema = z.object({
  unitId: z.guid(),
  firstName: z.string().min(1, 'First name is required.'),
  lastName: z.string().min(1, 'Last name is required.'),
  idNumber: saIdNumber,
  email: z.string().email('Enter a valid email address.'),
  phone: saPhone,
  employmentStatus: z.enum(['employed', 'self_employed', 'contract', 'unemployed', 'retired']),
  employer: z.string().optional(),
  monthlyIncomeCents: z.number().int().nonnegative(),
  occupants: z.number().int().min(1).max(12),
  preferredMoveIn: z.coerce.date(),
  pets: z.boolean().default(false),
  notes: z.string().max(2000).optional(),
});

export type CreateApplication = z.infer<typeof createApplicationSchema>;

export const decisionSchema = z.object({
  outcome: z.enum(['approved', 'declined']),
  reason: z.string().max(500).optional(),
});

/** The rule of thumb most South African landlords use: rent should not exceed a third of gross income. */
export const affordability = (monthlyIncomeCents: number, rentCents: number) => {
  const ratio = monthlyIncomeCents === 0 ? Infinity : rentCents / monthlyIncomeCents;
  return {
    ratio,
    band: ratio <= 0.3 ? 'comfortable' : ratio <= 0.4 ? 'tight' : 'over',
  } as const;
};
