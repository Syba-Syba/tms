import { z } from 'zod';
import { credentialVersion, signToken } from '../lib/authtoken';
import { dummyHash, verifyPassword } from '../lib/passwords';
import { audit } from '../lib/audit';
import { query } from '../lib/db';
import { mode } from '../lib/mode';
import { failedLoginsByAccount, failedLoginsByAddress } from '../lib/ratelimit';
import { json, parseBody, route, tooManyRequests, ApiError } from '../lib/http';

// The cap on password length keeps scrypt's input bounded; nobody types 200 characters.
const schema = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(200) });

/** Only the local driver answers here. In production, Cognito's hosted UI signs people in and
    API Gateway checks the token, so this route existing would be a misconfiguration. */
const requireLocalDriver = () => {
  if (process.env.AUTH_DRIVER !== 'local' || mode() === 'aws') {
    throw new ApiError(404, 'not_found', 'Sign-in is handled by Cognito in this environment.');
  }
};

const refuse = (retryAfter: number) =>
  tooManyRequests(
    `Too many sign-in attempts. Try again in ${Math.ceil(retryAfter / 60)} minute${retryAfter > 60 ? 's' : ''}.`,
  );

export const handler = route(async (event) => {
  requireLocalDriver();
  const input = parseBody(event, schema);
  const email = input.email.toLowerCase();
  const address = event.requestContext.http?.sourceIp ?? 'unknown';

  // Checked before the password, so a locked account costs an attacker nothing to probe and
  // the server nothing to answer.
  if (!failedLoginsByAccount.allows(email)) throw refuse(failedLoginsByAccount.retryAfterSeconds(email));
  if (!failedLoginsByAddress.allows(address)) throw refuse(failedLoginsByAddress.retryAfterSeconds(address));

  const [credential] = await query<{
    sub: string;
    email: string;
    name: string;
    role: 'landlord' | 'tenant';
    password_hash: string;
  }>('select sub, email, name, role, password_hash from local_credential where email = $1', [email]);

  // An unknown email still runs scrypt, against a hash that never matches, so the response
  // time does not say which emails have accounts. One message for both, for the same reason.
  const matched = verifyPassword(input.password, credential?.password_hash ?? dummyHash());
  if (!credential || !matched) {
    failedLoginsByAccount.record(email);
    failedLoginsByAddress.record(address);
    throw new ApiError(401, 'unauthorised', 'That email and password do not match.');
  }
  failedLoginsByAccount.clear(email);

  const user = {
    sub: credential.sub,
    role: credential.role,
    name: credential.name,
    email: credential.email,
  };
  await audit({
    actorSub: user.sub,
    actorRole: user.role,
    action: 'auth.login',
    entity: 'credential',
    // Credentials key on sub, not a uuid, so the id column stays empty.
    entityId: null,
    detail: { email: user.email },
  });
  return json(200, {
    token: signToken({ ...user, pv: credentialVersion(credential.password_hash) }),
    user,
  });
});
