import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** scrypt with a per-user salt. The `plain:` form exists only so seed files can carry the
    development password without shipping precomputed hashes. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 32).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  if (stored.startsWith('plain:')) {
    return process.env.NODE_ENV === 'development' && stored.slice(6) === password;
  }
  const [kind, salt, hash] = stored.split(':');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const candidate = scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
