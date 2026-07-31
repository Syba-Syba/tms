/** South African helpers that every local project ends up rewriting. */

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

export interface SaIdDetails {
  valid: boolean;
  dateOfBirth?: Date;
  gender?: 'male' | 'female';
  citizen?: boolean;
}

export function parseSaId(id: string): SaIdDetails {
  const digits = id.replace(/\D/g, '');
  if (digits.length !== 13 || !luhnValid(digits)) return { valid: false };

  const year = Number(digits.slice(0, 2));
  const month = Number(digits.slice(2, 4));
  const day = Number(digits.slice(4, 6));
  const currentYear = new Date().getFullYear() % 100;
  const century = year <= currentYear ? 2000 : 1900;
  const dateOfBirth = new Date(century + year, month - 1, day);
  if (dateOfBirth.getMonth() !== month - 1 || dateOfBirth.getDate() !== day) return { valid: false };

  return {
    valid: true,
    dateOfBirth,
    gender: Number(digits.slice(6, 10)) >= 5000 ? 'male' : 'female',
    citizen: digits[10] === '0',
  };
}

export const isValidSaId = (id: string) => parseSaId(id).valid;

/** Accepts 0821234567, 27821234567 or +27 82 123 4567 and always returns +27821234567. */
export function normaliseSaPhone(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('0')) return `+27${digits.slice(1)}`;
  if (digits.length === 11 && digits.startsWith('27')) return `+${digits}`;
  if (digits.length === 9) return `+27${digits}`;
  return null;
}

export const formatZar = (amount: number, withCents = true) =>
  new Intl.NumberFormat('en-ZA', {
    style: 'currency',
    currency: 'ZAR',
    minimumFractionDigits: withCents ? 2 : 0,
    maximumFractionDigits: withCents ? 2 : 0,
  }).format(amount);

export const VAT_RATE = 0.15;
export const addVat = (excl: number) => Math.round(excl * (1 + VAT_RATE) * 100) / 100;
export const stripVat = (incl: number) => Math.round((incl / (1 + VAT_RATE)) * 100) / 100;
