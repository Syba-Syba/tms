import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { secretFor } from './mode';

/**
 * An HMAC-SHA256 signed payload with an expiry, verified without any AWS. In development it
 * is a stand-in for a Cognito ID token; in self-hosted mode it is the real session token, and
 * the server verifies it on every request. In aws mode nothing here runs: API Gateway's JWT
 * authorizer checks a Cognito token before a request reaches a handler.
 */
export interface TokenUser {
  sub: string;
  role: 'landlord' | 'tenant';
  name: string;
  email: string;
  /**
   * A fingerprint of the password hash this token was issued against. Tokens are stateless and
   * live for days, so without it a changed password left every stolen session working until it
   * expired. The self-hosted server compares it with the stored hash on each request.
   */
  pv?: string;
}

/**
 * Changes whenever the password does, or the account signs out, and reveals nothing about
 * either. Epoch 0 hashes the password alone, so tokens issued before the epoch existed still work.
 */
export const credentialVersion = (passwordHash: string, sessionEpoch = 0) =>
  createHash('sha256')
    .update(sessionEpoch ? `${passwordHash}:${sessionEpoch}` : passwordHash)
    .digest('base64url')
    .slice(0, 16);

// Anyone holding the example value from this repository could otherwise mint a landlord
// session, so outside development it has to be a real one.
const secret = () => secretFor('AUTH_SECRET', 'tms-local-dev-secret');

const b64url = (input: string) => Buffer.from(input, 'utf8').toString('base64url');

const hmac = (payload: string) => createHmac('sha256', secret()).update(payload).digest('base64url');

export function signToken(user: TokenUser, daysValid = 7): string {
  const payload = b64url(
    JSON.stringify({ ...user, exp: Math.floor(Date.now() / 1000) + daysValid * 86400 }),
  );
  return `${payload}.${hmac(payload)}`;
}

export function verifyToken(token: string): TokenUser | null {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = hmac(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof decoded.exp !== 'number' || decoded.exp < Date.now() / 1000) return null;
    return {
      sub: decoded.sub,
      role: decoded.role,
      name: decoded.name,
      email: decoded.email,
      ...(typeof decoded.pv === 'string' ? { pv: decoded.pv } : {}),
    };
  } catch {
    return null;
  }
}
