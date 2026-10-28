/**
 * A random id for a one-shot client action, such as the idempotency key on a payment.
 * crypto.randomUUID is missing outside a secure context (plain HTTP on the LAN), so this
 * falls back to the always-present getRandomValues, and after that to Math.random.
 */
export function randomId(): string {
  if (typeof crypto !== 'undefined') {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    if (typeof crypto.getRandomValues === 'function') {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    }
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
