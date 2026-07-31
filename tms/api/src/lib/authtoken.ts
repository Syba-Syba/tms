import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The local stand-in for a Cognito ID token: a signed payload the dev server can verify
 * without any AWS. Production never sees these; API Gateway's JWT authorizer checks real
 * Cognito tokens before a request reaches a handler.
 */
export interface TokenUser {
  sub: string;
  role: 'landlord' | 'tenant';
  name: string;
  email: string;
}

const secret = () => process.env.AUTH_SECRET ?? 'tms-local-dev-secret';

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
    return { sub: decoded.sub, role: decoded.role, name: decoded.name, email: decoded.email };
  } catch {
    return null;
  }
}
