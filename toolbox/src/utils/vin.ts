const TRANSLIT: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/** Checks length, banned letters and the ISO 3779 check digit in position nine. */
export function isValidVin(vin: string): boolean {
  const value = vin.trim().toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(value)) return false;

  let sum = 0;
  for (let i = 0; i < 17; i += 1) {
    const char = value[i] as string;
    const digit = /\d/.test(char) ? Number(char) : TRANSLIT[char];
    if (digit === undefined) return false;
    sum += digit * (WEIGHTS[i] as number);
  }

  const expected = sum % 11;
  const check = value[8];
  return check === (expected === 10 ? 'X' : String(expected));
}

export const vinModelYear = (vin: string) => {
  const codes = 'ABCDEFGHJKLMNPRSTVWXY123456789';
  const index = codes.indexOf(vin.toUpperCase()[9] ?? '');
  return index === -1 ? null : 2010 + index;
};
