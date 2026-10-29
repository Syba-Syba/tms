import { z } from 'zod';
import { audit } from '../lib/audit';
import { caller } from '../lib/auth';
import { query, withTransaction } from '../lib/db';
import { ApiError, badRequest, conflict, json, parseBody, route, tooManyRequests } from '../lib/http';
import { verifyPassword } from '../lib/passwords';
import { requireLocalDriver } from '../lib/password-reset';
import { requireSecondStep } from '../lib/two-step';
import { passwordChangesByAccount } from '../lib/ratelimit';
import { sendDirectEmail } from './notifications-dispatch';
import { hashRecoveryCode, matchingStep, newRecoveryCodes, newTotpSecret, openSecret, otpauthUrl, sealSecret } from '../lib/totp';

const password = z.string().min(1, 'Enter your password.').max(200);
const setupSchema = z.object({ action: z.literal('setup'), password });
const enableSchema = z.object({ action: z.literal('enable'), password, code: z.string().trim().min(6).max(12) });
const disableSchema = z.object({ action: z.literal('disable'), password, code: z.string().trim().min(6).max(12) });

/**
 * Two-step sign-in for the signed-in person. GET says whether it is on. POST with
 * `action: 'setup'` makes a secret to scan; 'enable' turns it on with a first code and returns
 * the recovery codes, once; 'disable' needs a code. Every change needs the current password:
 * a stolen session alone could otherwise turn two-step on with the thief's own app, change the
 * bank account rent goes into, and lock the owner out.
 */
export const handler = route(async (event) => {
  requireLocalDriver();
  const person = caller(event);
  const [credential] = await query<{ email: string; password_hash: string; enabled: boolean; codes_left: string }>(
    `select email, password_hash, totp_enabled_at is not null as enabled,
            (select count(*) from recovery_code r where r.sub = c.sub and r.used_at is null)::text as codes_left
       from local_credential c where sub = $1`,
    [person.sub],
  );
  if (!credential) throw badRequest('This sign-in has no password here, so two-step is managed by your identity provider.');

  const method = event.requestContext.http.method;
  if (method === 'GET') return json(200, { enabled: credential.enabled, recoveryCodesLeft: Number(credential.codes_left) });

  const action = (JSON.parse(event.body ?? '{}') as { action?: string }).action;
  // Wrong passwords are counted, and answered with a 403 so the app shows the error instead of
  // treating it as an expired session.
  const confirmPassword = (given: string) => {
    if (!passwordChangesByAccount.allows(person.sub)) {
      throw tooManyRequests('Too many wrong passwords. Try again in a few minutes.');
    }
    if (!verifyPassword(given, credential.password_hash)) {
      passwordChangesByAccount.record(person.sub);
      throw new ApiError(403, 'password_wrong', 'That is not your password.');
    }
  };
  if (action === 'setup') {
    const input = parseBody(event, setupSchema);
    if (credential.enabled) throw conflict('Two-step sign-in is already on.');
    confirmPassword(input.password);
    const secret = newTotpSecret();
    await query('update local_credential set totp_secret_enc = $2, totp_last_step = null where sub = $1', [person.sub, sealSecret(secret)]);
    return json(200, { secret, otpauthUrl: otpauthUrl(secret, credential.email) });
  }

  if (action === 'enable') {
    const { code, password: given } = parseBody(event, enableSchema);
    if (credential.enabled) throw conflict('Two-step sign-in is already on.');
    confirmPassword(given);
    const [row] = await query<{ secret: Buffer | null }>('select totp_secret_enc as secret from local_credential where sub = $1', [person.sub]);
    if (!row?.secret) throw badRequest('Start again: scan the code first.');
    const step = matchingStep(openSecret(row.secret), code, null);
    if (step === null) throw new ApiError(400, 'code_wrong', 'That code did not match. Check the time on your phone and try the newest code.');
    const codes = newRecoveryCodes();
    await withTransaction(async (run) => {
      await run('update local_credential set totp_enabled_at = now(), totp_last_step = $2 where sub = $1', [person.sub, step]);
      await run('delete from recovery_code where sub = $1', [person.sub]);
      for (const recovery of codes) {
        await run('insert into recovery_code (sub, code_hash) values ($1, $2)', [person.sub, hashRecoveryCode(recovery)]);
      }
    });
    await audit({ actorSub: person.sub, actorRole: person.groups[0] ?? 'unknown', action: 'auth.two_step_on', entity: 'credential', entityId: null, detail: {} });
    // Said to the inbox on file, so a change made by someone else does not go unnoticed.
    await sendDirectEmail(
      credential.email,
      'Two-step sign-in was turned on',
      'Two-step sign-in was just turned on for your Threshold account. If that was not you, reset your password and contact support straight away.',
    ).catch(() => undefined);
    return json(200, { enabled: true, recoveryCodes: codes });
  }

  if (action === 'disable') {
    const input = parseBody(event, disableSchema);
    if (!credential.enabled) throw conflict('Two-step sign-in is already off.');
    confirmPassword(input.password);
    await requireSecondStep(person.sub, input.code);
    await withTransaction(async (run) => {
      await run('update local_credential set totp_enabled_at = null, totp_secret_enc = null, totp_last_step = null where sub = $1', [person.sub]);
      await run('delete from recovery_code where sub = $1', [person.sub]);
    });
    await audit({ actorSub: person.sub, actorRole: person.groups[0] ?? 'unknown', action: 'auth.two_step_off', entity: 'credential', entityId: null, detail: {} });
    return json(200, { enabled: false });
  }

  throw badRequest('Unknown action.');
});
