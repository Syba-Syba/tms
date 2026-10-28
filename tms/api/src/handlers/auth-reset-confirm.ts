import { z } from 'zod';
import { audit } from '../lib/audit';
import { credentialVersion, signToken } from '../lib/authtoken';
import { withTransaction } from '../lib/db';
import { ApiError, json, parseBody, route, tooManyRequests } from '../lib/http';
import { hashResetToken, requireLocalDriver } from '../lib/password-reset';
import { hashPassword } from '../lib/passwords';
import { resetConfirmsByAddress } from '../lib/ratelimit';

const schema = z.object({
  token: z.string().min(20).max(200),
  newPassword: z.string().min(8, 'Use at least 8 characters.').max(200, 'Use at most 200 characters.'),
});

const invalid = () =>
  new ApiError(400, 'invalid_token', 'That reset link has expired or was already used. Ask for a new one.');

/**
 * Sets the new password and signs the caller in. Every existing session ends, because tokens
 * carry a fingerprint of the password hash and the server checks it on each request.
 */
export const handler = route(async (event) => {
  requireLocalDriver();
  const address = event.requestContext.http?.sourceIp ?? 'unknown';
  if (!resetConfirmsByAddress.allows(address)) {
    throw tooManyRequests('Too many attempts. Try again in a few minutes.');
  }
  resetConfirmsByAddress.record(address);
  const input = parseBody(event, schema);
  const passwordHash = hashPassword(input.newPassword);

  const user = await withTransaction(async (run) => {
    // Claimed and spent in one statement, so two tabs racing the same link cannot both win.
    const [reset] = await run<{ sub: string }>(
      `update password_reset set used_at = now()
        where token_hash = $1 and used_at is null and expires_at > now()
        returning sub`,
      [hashResetToken(input.token)],
    );
    if (!reset) throw invalid();

    const [credential] = await run<{ email: string; name: string; role: 'landlord' | 'tenant'; two_step: boolean }>(
      `update local_credential set password_hash = $2 where sub = $1
       returning email, name, role, totp_enabled_at is not null as two_step`,
      [reset.sub, passwordHash],
    );
    if (!credential) throw invalid();

    // The emailed link is the only thing in the outbox that grants access. Once spent it has
    // no reason to stay readable in the table.
    await run(
      `update notification set body = '[reset link removed after use]'
        where recipient_sub = $1 and kind = 'password_reset'`,
      [reset.sub],
    );
    return { sub: reset.sub, ...credential };
  });

  await audit({
    actorSub: user.sub,
    actorRole: user.role,
    action: 'auth.password_reset',
    entity: 'credential',
    entityId: null,
    detail: { email: user.email },
  });
  // With two-step on, the emailed link alone must not sign anyone in: whoever reads the inbox
  // would be in. The password is changed; signing in still needs the code.
  if (user.two_step) return json(200, { token: null, user: null, signInWithCode: true });
  const { two_step: _twoStep, ...signedIn } = user;
  return json(200, { token: signToken({ ...signedIn, pv: credentialVersion(passwordHash) }), user: signedIn });
});
