import { z } from 'zod';
import { credentialVersion, signToken } from '../lib/authtoken';
import { hashPassword, verifyPassword } from '../lib/passwords';
import { audit } from '../lib/audit';
import { caller } from '../lib/auth';
import { query } from '../lib/db';
import { mode } from '../lib/mode';
import { passwordChangesByAccount } from '../lib/ratelimit';
import { badRequest, json, parseBody, route, tooManyRequests, ApiError } from '../lib/http';

const schema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(8, 'Use at least 8 characters.').max(200, 'Use at most 200 characters.'),
});

/**
 * Changing a password did not exist, so a password that had been shared or seen could only be
 * replaced by deleting the database. The current password is required, so a session left open
 * on someone else's phone cannot be used to lock its owner out.
 *
 * Every token carries a fingerprint of the hash it was issued against, so changing the password
 * ends every other session. The caller gets a fresh token and stays signed in.
 */
export const handler = route(async (event) => {
  if (process.env.AUTH_DRIVER !== 'local' || mode() === 'aws') {
    throw new ApiError(404, 'not_found', 'Passwords are managed by Cognito in this environment.');
  }
  const { sub } = caller(event);
  if (!passwordChangesByAccount.allows(sub)) {
    throw tooManyRequests('Too many attempts. Try again in a few minutes.');
  }
  const input = parseBody(event, schema);

  const [credential] = await query<{
    email: string;
    name: string;
    role: 'landlord' | 'tenant';
    password_hash: string;
    session_epoch: number;
  }>('select email, name, role, password_hash, session_epoch from local_credential where sub = $1', [sub]);
  if (!credential) throw new ApiError(404, 'not_found', 'No password is set for this account.');

  passwordChangesByAccount.record(sub);
  if (!verifyPassword(input.currentPassword, credential.password_hash)) {
    throw badRequest('Some fields need fixing.', { currentPassword: 'That is not your current password.' });
  }
  if (input.newPassword === input.currentPassword) {
    throw badRequest('Some fields need fixing.', { newPassword: 'Choose a password you have not used here.' });
  }

  const passwordHash = hashPassword(input.newPassword);
  await query('update local_credential set password_hash = $1 where sub = $2', [passwordHash, sub]);
  passwordChangesByAccount.clear(sub);

  await audit({
    actorSub: sub,
    actorRole: credential.role,
    action: 'auth.password_changed',
    entity: 'credential',
    entityId: null,
    detail: { email: credential.email },
  });

  const user = { sub, role: credential.role, name: credential.name, email: credential.email };
  return json(200, { token: signToken({ ...user, pv: credentialVersion(passwordHash, credential.session_epoch) }), user });
});
