import { createHash, randomBytes } from 'node:crypto';
import { ApiError } from './http';
import { mode } from './mode';

/** Long enough to find the email, short enough that a forwarded link goes stale quickly. */
export const RESET_TTL_MINUTES = 30;

export const newResetToken = () => randomBytes(32).toString('base64url');

export const hashResetToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Only the local driver resets passwords. Cognito owns this in aws mode. */
export const requireLocalDriver = () => {
  if (process.env.AUTH_DRIVER !== 'local' || mode() === 'aws') {
    throw new ApiError(404, 'not_found', 'Password reset is handled by Cognito in this environment.');
  }
};

/**
 * Where the emailed link points. The self-hosted server serves the app and the API on one
 * origin, so PUBLIC_API_URL is the app's address too. A link built from the request's Host
 * header would let anyone send a real reset email pointing at their own site.
 */
export function appUrl(): string {
  const configured = (process.env.PUBLIC_APP_URL || process.env.PUBLIC_API_URL || '').trim();
  if (configured) return configured.replace(/\/+$/, '');
  if (mode() === 'development') return 'http://localhost:5173';
  throw new ApiError(
    503,
    'not_configured',
    'Password reset is not set up on this server. Ask the landlord to set PUBLIC_APP_URL.',
  );
}

export const resetEmail = (name: string, link: string) => ({
  subject: 'Reset your password',
  body:
    `Hi ${name},\n\n` +
    `Someone asked to reset the password for this account. If it was you, open this link within ` +
    `${RESET_TTL_MINUTES} minutes and choose a new one:\n\n${link}\n\n` +
    `The link works once. If you did not ask for this, ignore this email; your password stays as it is.`,
});
