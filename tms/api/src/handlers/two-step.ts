import { z } from 'zod';
import { audit } from '../lib/audit';
import { caller } from '../lib/auth';
import { query, withTransaction } from '../lib/db';
import { ApiError, badRequest, conflict, json, parseBody, route } from '../lib/http';
import { verifyPassword } from '../lib/passwords';
import { requireLocalDriver } from '../lib/password-reset';
import { checkSecondStep } from '../lib/two-step';
import { hashRecoveryCode, matchingStep, newRecoveryCodes, newTotpSecret, openSecret, otpauthUrl, sealSecret } from '../lib/totp';

const codeSchema = z.object({ code: z.string().trim().min(6).max(12) });
const disableSchema = z.object({ password: z.string().min(1).max(200), code: z.string().trim().min(6).max(12) });

/**
 * Two-step sign-in for the signed-in person. GET says whether it is on. POST with
 * `action: 'setup'` makes a secret to scan; 'enable' turns it on with a first code and returns
 * the recovery codes, once; 'disable' needs the password and a code.
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
  if (action === 'setup') {
    if (credential.enabled) throw conflict('Two-step sign-in is already on.');
    const secret = newTotpSecret();
    await query('update local_credential set totp_secret_enc = $2, totp_last_step = null where sub = $1', [person.sub, sealSecret(secret)]);
    return json(200, { secret, otpauthUrl: otpauthUrl(secret, credential.email) });
  }

  if (action === 'enable') {
    const { code } = parseBody(event, codeSchema.extend({ action: z.literal('enable') }));
    if (credential.enabled) throw conflict('Two-step sign-in is already on.');
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
    return json(200, { enabled: true, recoveryCodes: codes });
  }

  if (action === 'disable') {
    const input = parseBody(event, disableSchema.extend({ action: z.literal('disable') }));
    if (!credential.enabled) throw conflict('Two-step sign-in is already off.');
    if (!verifyPassword(input.password, credential.password_hash)) throw new ApiError(401, 'unauthorised', 'That is not your password.');
    if (!(await checkSecondStep(person.sub, input.code))) throw new ApiError(401, 'code_wrong', 'That code did not match.');
    await withTransaction(async (run) => {
      await run('update local_credential set totp_enabled_at = null, totp_secret_enc = null, totp_last_step = null where sub = $1', [person.sub]);
      await run('delete from recovery_code where sub = $1', [person.sub]);
    });
    await audit({ actorSub: person.sub, actorRole: person.groups[0] ?? 'unknown', action: 'auth.two_step_off', entity: 'credential', entityId: null, detail: {} });
    return json(200, { enabled: false });
  }

  throw badRequest('Unknown action.');
});
