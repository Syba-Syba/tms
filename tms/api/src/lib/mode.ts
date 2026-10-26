/**
 * There were two modes and no way to say what this one is: development, where every
 * convenience driver is on and identity is whatever a header claims, and AWS, where none of
 * them are permitted. Running the system for real without an AWS account fell between them,
 * and the only way to reach it was to claim to be development, which turns identity off.
 *
 * So there are three, and every guard keys off this rather than reading NODE_ENV directly:
 *
 *   development  Everything local. Weak secrets tolerated. Headers can claim any identity.
 *   self-hosted  Real users on a machine you run. The local drivers stay, but only with real
 *                secrets, and only behind a server that checks a password.
 *   aws          Lambda, RDS, S3, KMS, Cognito. No local driver is permitted at all.
 */
export type Mode = 'development' | 'self-hosted' | 'aws';

export function mode(): Mode {
  if (process.env.NODE_ENV === 'development') return 'development';
  return process.env.APP_MODE === 'self-hosted' ? 'self-hosted' : 'aws';
}

export const isDevelopment = () => mode() === 'development';
export const isSelfHosted = () => mode() === 'self-hosted';

/**
 * The pglite database, on-disk storage and local key drivers. Allowed in development because
 * nothing is real, and in self-hosted because the secrets are checked and the box is yours.
 * Never in aws, where the managed service exists and the local one would be a silent downgrade.
 */
export const allowsLocalDrivers = () => mode() !== 'aws';

/** Everything that has ever been committed to this repo as an example value. */
const PUBLISHED_DEFAULTS = new Set([
  'tms-local-dev-secret',
  'local-development-only',
  'local-only-password',
  'change-me',
  'changeme',
  'secret',
  'password',
]);

const MIN_LENGTH = 32;

/**
 * Self-hosted mode signs session tokens and document links with these, so a placeholder is not
 * a smaller version of the problem, it is the whole problem: anyone holding the example value
 * from this repository could mint a valid landlord session.
 */
export function assertStrongSecret(name: string, value: string | undefined): asserts value is string {
  const problems: string[] = [];
  if (!value) {
    problems.push('is not set');
  } else {
    if (PUBLISHED_DEFAULTS.has(value)) problems.push('is the example value published in this repository');
    if (value.length < MIN_LENGTH) {
      problems.push(`is ${value.length} characters, and needs at least ${MIN_LENGTH}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`${name} ${problems.join(', and ')}. Generate one with: openssl rand -base64 48`);
  }
}

/**
 * Reads a secret, tolerating the development placeholder only in development. Callers get a
 * usable string in every mode, or an error naming the variable and how to make one.
 */
export function secretFor(name: 'AUTH_SECRET' | 'STORAGE_SECRET', developmentFallback: string): string {
  const value = process.env[name];
  if (isDevelopment()) return value || developmentFallback;
  assertStrongSecret(name, value);
  return value;
}

/**
 * Checked once at boot rather than on the first request that happens to need one, so a bad
 * configuration stops the server instead of failing somewhere downstream at 2am.
 */
export function assertSelfHostedConfig(): void {
  const failures: string[] = [];
  for (const name of ['AUTH_SECRET', 'STORAGE_SECRET'] as const) {
    try {
      assertStrongSecret(name, process.env[name]);
    } catch (error) {
      failures.push(`  - ${(error as Error).message}`);
    }
  }
  if (process.env.AUTH_DRIVER !== 'local') {
    failures.push('  - AUTH_DRIVER must be "local": self-hosted mode has no Cognito to defer to.');
  }
  if (failures.length > 0) {
    throw new Error(`Self-hosted mode is not configured:\n${failures.join('\n')}`);
  }
}
