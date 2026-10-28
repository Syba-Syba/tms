import { audit } from '../lib/audit';
import { caller } from '../lib/auth';
import { query } from '../lib/db';
import { mode } from '../lib/mode';
import { ApiError, json, route } from '../lib/http';

/**
 * Signing out used to only forget the token on the device. A copy of it (a shared phone, a
 * backup, a log) kept working for the rest of its seven days. Bumping the account's session
 * epoch changes the fingerprint every token is checked against, so all of them stop working.
 * It signs the account out everywhere, which is the safe meaning of "sign out" on a shared device.
 */
export const handler = route(async (event) => {
  if (process.env.AUTH_DRIVER !== 'local' || mode() === 'aws') {
    throw new ApiError(404, 'not_found', 'Sessions are managed by Cognito in this environment.');
  }
  const { sub, groups } = caller(event);
  await query('update local_credential set session_epoch = session_epoch + 1 where sub = $1', [sub]);
  await audit({ actorSub: sub, actorRole: groups[0] ?? 'unknown', action: 'auth.logout', entity: 'credential', entityId: null });
  return json(200, { signedOut: true });
});
