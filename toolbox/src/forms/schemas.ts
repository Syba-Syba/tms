import { z } from 'zod';
import { isValidSaId, normaliseSaPhone } from '../utils/sa';
import { isValidVin } from '../utils/vin';

export const saIdSchema = z.string().refine(isValidSaId, 'Enter a valid 13 digit South African ID.');

export const saPhoneSchema = z
  .string()
  .transform((value) => normaliseSaPhone(value))
  .refine((value): value is string => value !== null, 'Enter a valid South African mobile number.');

export const vinSchema = z
  .string()
  .transform((value) => value.trim().toUpperCase())
  .refine(isValidVin, 'Enter a valid 17 character VIN.');

export const emailSchema = z.string().email('Enter a valid email address.');

export const requiredString = (field: string) => z.string().min(1, `${field} is required.`);

export const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters.')
  .regex(/[a-z]/, 'Add a lowercase letter.')
  .regex(/[A-Z]/, 'Add an uppercase letter.')
  .regex(/\d/, 'Add a number.');
