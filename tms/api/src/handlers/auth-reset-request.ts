import { z } from 'zod';
import { audit } from '../lib/audit';
import { query, withTransaction } from '../lib/db';
import { json, parseBody, route, tooManyRequests } from '../lib/http';
import {
  appUrl,
  hashResetToken,
  newResetToken,
  requireLocalDriver,
  resetEmail,
  RESET_TTL_MINUTES,
} from '../lib/password-reset';
import { resetRequestsByAccount, resetRequestsByAddress } from '../lib/ratelimit';

const schema = z.object({ email: z.string().email().max(254) });

/**
 * Always answers 202 with the same body, whether or not the email has an account, so this
 * cannot be used to check who is a tenant here. The email goes through the notification
 * outbox like every other message, urgent so quiet hours do not hold it until morning.
 */
export const handler = route(async (event) => {
  requireLocalDriver();
  // Fails before anything is written, and says nothing about the email.
  const base = appUrl();
  const address = event.requestContext.http?.sourceIp ?? 'unknown';
  if (!resetRequestsByAddress.allows(address)) {
    throw tooManyRequests('Too many reset requests from this connection. Try again later.');
  }
  resetRequestsByAddress.record(address);
  const email = parseBody(event, schema).email.toLowerCase();
  const answer = json(202, {
    message: 'If that email has an account, a reset link is on its way. It works for 30 minutes.',
  });

  const [credential] = await query<{ sub: string; name: string; role: string }>(
    'select sub, name, role from local_credential where email = $1',
    [email],
  );
  if (!credential || !resetRequestsByAccount.allows(email)) return answer;
  resetRequestsByAccount.record(email);

  const token = newResetToken();
  const { subject, body } = resetEmail(credential.name, `${base}/reset-password?token=${token}`);
  await withTransaction(async (run) => {
    // One live link at a time: asking again retires the earlier ones.
    await run(
      'update password_reset set used_at = now() where sub = $1 and used_at is null',
      [credential.sub],
    );
    await run(
      `insert into password_reset (sub, token_hash, expires_at)
       values ($1, $2, now() + make_interval(mins => $3))`,
      [credential.sub, hashResetToken(token), RESET_TTL_MINUTES],
    );
    await run(
      `insert into notification
         (recipient_sub, recipient_to, channel, category, kind, urgent, subject, body)
       values ($1, $2, 'email', 'account', 'password_reset', true, $3, $4)`,
      [credential.sub, email, subject, body],
    );
  });

  await audit({
    actorSub: credential.sub,
    actorRole: credential.role,
    action: 'auth.reset_requested',
    entity: 'credential',
    entityId: null,
    detail: { email },
  });
  return answer;
});
