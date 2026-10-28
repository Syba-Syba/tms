import { query } from './db';
import { hashRecoveryCode, matchingStep, openSecret } from './totp';

type Run = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

export async function twoStepEnabled(sub: string, run: Run = query): Promise<boolean> {
  const [row] = await run<{ on: boolean }>(
    'select totp_enabled_at is not null as on from local_credential where sub = $1',
    [sub],
  );
  return Boolean(row?.on);
}

/**
 * Checks the second step for a sign-in or a sensitive change: a current code from the app, or
 * one of the recovery codes, which then cannot be used again. Accepting a code records its
 * step, so the same six digits do not work twice.
 */
export async function checkSecondStep(sub: string, code: string | undefined, run: Run = query): Promise<boolean> {
  if (!code) return false;
  const [row] = await run<{ secret: Buffer | null; last_step: string | null }>(
    'select totp_secret_enc as secret, totp_last_step::text as last_step from local_credential where sub = $1 and totp_enabled_at is not null',
    [sub],
  );
  if (!row?.secret) return false;
  const step = matchingStep(openSecret(row.secret), code, row.last_step === null ? null : Number(row.last_step));
  if (step !== null) {
    const updated = await run(
      `update local_credential set totp_last_step = $2
        where sub = $1 and (totp_last_step is null or totp_last_step < $2) returning sub`,
      [sub, step],
    );
    return updated.length > 0;
  }
  if (/^\d+$/.test(code.replace(/\s/g, ''))) return false;
  const used = await run(
    `update recovery_code set used_at = now() where sub = $1 and code_hash = $2 and used_at is null returning sub`,
    [sub, hashRecoveryCode(code)],
  );
  return used.length > 0;
}
