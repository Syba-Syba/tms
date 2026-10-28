import { z } from 'zod';

export const propertySchema = z.object({
  name: z.string().trim().min(2).max(80),
  addressLine1: z.string().trim().min(3).max(120),
  suburb: z.string().trim().min(2).max(60),
  city: z.string().trim().min(2).max(60),
  province: z.enum([
    'Eastern Cape', 'Free State', 'Gauteng', 'KwaZulu-Natal', 'Limpopo',
    'Mpumalanga', 'North West', 'Northern Cape', 'Western Cape',
  ]),
  postalCode: z.string().trim().regex(/^\d{4}$/, 'A South African postal code is 4 digits.'),
});

export const unitSchema = z.object({
  code: z.string().trim().min(1).max(20),
  bedrooms: z.number().int().min(0).max(20),
  bathrooms: z.number().int().min(1).max(20),
  monthlyRentCents: z.number().int().positive(),
  depositCents: z.number().int().min(0),
});

/** What the public listings page shows beyond the numbers. */
export const listingSchema = z.object({
  description: z.string().trim().max(2000).nullable(),
  availableFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-12-01.').nullable(),
  furnished: z.boolean(),
  petsAllowed: z.boolean(),
  parkingBays: z.number().int().min(0).max(10),
  // Hidden units stay off the public page, though anyone with the link to apply still can.
  listed: z.boolean(),
});

// Edits never touch status: the application and lease flows own that machine.
export const unitUpdateSchema = unitSchema.merge(listingSchema).partial();
export const propertyUpdateSchema = propertySchema.partial();
