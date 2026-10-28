import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { secretFor } from './mode';

/**
 * Time-based one-time codes (RFC 6238), the kind Google Authenticator and Microsoft
 * Authenticator show: HMAC-SHA1, 30-second steps, 6 digits. Small enough to keep in-house.
 */
const STEP_SECONDS = 30;
const DIGITS = 6;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Not base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32Encode(randomBytes(20));

export const stepAt = (now: number = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

export function codeFor(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 15;
  const binary = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(binary).padStart(DIGITS, '0');
}

/**
 * The step a code matches, allowing one step either side for a phone clock that is a little
 * off, or null. A step at or before `lastStep` was already used and is refused.
 */
export function matchingStep(secret: string, code: string, lastStep: number | null, now: number = Date.now()): number | null {
  const digits = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(digits)) return null;
  const current = stepAt(now);
  for (const step of [current - 1, current, current + 1]) {
    if (lastStep !== null && step <= lastStep) continue;
    const expected = Buffer.from(codeFor(secret, step));
    if (timingSafeEqual(expected, Buffer.from(digits))) return step;
  }
  return null;
}

export const otpauthUrl = (secret: string, account: string, issuer = 'Threshold') =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;

/* The secret has to be read back to check codes, so unlike ID numbers it is encrypted with a
   key the server holds: AES-256-GCM under a key derived from the auth secret. */
const key = () => scryptSync(secretFor('AUTH_SECRET', 'tms-local-dev-secret'), 'totp-secret', 32);

export function sealSecret(secret: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function openSecret(sealed: Buffer | Uint8Array): string {
  const bytes = Buffer.from(sealed);
  const decipher = createDecipheriv('aes-256-gcm', key(), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
}

/* Recovery codes: ten groups like 7KQ2-M9XD, hashed like reset tokens. */
export const newRecoveryCodes = () =>
  Array.from({ length: 10 }, () => {
    const raw = base32Encode(randomBytes(5)).slice(0, 8);
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });

export const hashRecoveryCode = (code: string) =>
  createHash('sha256').update(code.toUpperCase().replace(/[^A-Z2-7]/g, '')).digest('hex');
