import { ApiError } from './http';
import { mode } from './mode';

export type BillingDriver = 'payfast' | 'local' | 'off';

/**
 * 'payfast' takes real payments: the hosted service. 'off' charges nobody: a self-hosted
 * install that someone runs for their own portfolio. 'local' simulates payments so the whole
 * flow runs on a laptop and in tests, and only in development.
 *
 * Defaults follow the mode, so a hosted deploy that forgets the setting still charges.
 */
export function billingDriver(): BillingDriver {
  const value = process.env.BILLING_DRIVER ?? { development: 'local', 'self-hosted': 'off', aws: 'payfast' }[mode()];
  if (value === 'local' && mode() !== 'development') {
    throw new ApiError(503, 'not_configured', 'Simulated billing only runs in development.');
  }
  if (value !== 'payfast' && value !== 'local' && value !== 'off') {
    throw new ApiError(503, 'not_configured', `Unknown BILLING_DRIVER ${value}.`);
  }
  return value;
}
