import { z } from 'zod';
import { credentialVersion, signToken } from '../lib/authtoken';
import { dummyHash, verifyPassword } from '../lib/passwords';
import { audit } from '../lib/audit';
import { query } from '../lib/db';
import { mode } from '../lib/mode';
import { failedLoginsByAccount, failedLoginsByAddress } from '../lib/ratelimit';
import { json, parseBody, route, tooManyRequests, ApiError } from '../lib/http';
import { checkSecondStep, twoStepEnabled } from '../lib/two-step';

// The cap on password length keeps scrypt's input bounded; nobody types 200 characters.
const schema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
  // The authenticator code, or a recovery code, when two-step sign-in is on.
  code: z.string().trim().max(12).optional(),
});

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
    session_epoch: number;
  }>(
    'select sub, email, name, role, password_hash, session_epoch from local_credential where email = $1',
    [email],
  );

  // An unknown email still runs scrypt, against a hash that never matches, so the response
  // time does not say which emails have accounts. One message for both, for the same reason.
  const matched = verifyPassword(input.password, credential?.password_hash ?? dummyHash());
  if (!credential || !matched) {
    failedLoginsByAccount.record(email);
    failedLoginsByAddress.record(address);
    // A run of these against one account, or from one address, is what a password-guessing
    // attempt looks like afterwards. The rate limiter forgets on restart; this does not.
    await audit({
      actorSub: credential?.sub ?? '',
      actorRole: credential?.role ?? 'unknown',
      action: 'auth.login_failed',
      entity: 'credential',
      entityId: null,
      detail: { email, address, knownAccount: Boolean(credential) },
    });
    throw new ApiError(401, 'unauthorised', 'That email and password do not match.');
  }
  // The password was right. With two-step on, it is not enough: the code comes next, and a
  // wrong code counts as a failed attempt, so six digits cannot be guessed at leisure.
  if (await twoStepEnabled(credential.sub)) {
    if (!input.code) throw new ApiError(401, 'code_required', 'Enter the code from your authenticator app.');
    if (!(await checkSecondStep(credential.sub, input.code))) {
      failedLoginsByAccount.record(email);
      failedLoginsByAddress.record(address);
      await audit({
        actorSub: credential.sub, actorRole: credential.role, action: 'auth.login_failed', entity: 'credential',
        entityId: null, detail: { email, address, knownAccount: true, secondStep: true },
      });
      throw new ApiError(401, 'code_wrong', 'That code did not match. Use the newest one, or a recovery code.');
    }
  }
  failedLoginsByAccount.clear(email);

  // An agent the owner has removed keeps a password but no longer has an account to work on.
  if (credential.role === 'landlord') {
    const [member] = await query('select 1 from landlord_member where sub = $1', [credential.sub]);
    if (!member) throw new ApiError(403, 'forbidden', 'Your access to this landlord account has ended.');
  }

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
    token: signToken({ ...user, pv: credentialVersion(credential.password_hash, credential.session_epoch) }),
    user,
  });
});
