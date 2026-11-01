import { describe, expect, it } from 'vitest';
import { signingProgress } from '../lease-review';

describe('signingProgress', () => {
  it('shows the tenant signed and the landlord not, when only the tenant has signed', () => {
    const progress = signingProgress('out_for_signature', ['tenant']);
    expect(progress.done).toEqual([true, true, false, true, false]);
    expect(progress.current).toBe(2);
  });

  it('follows each signature, whatever the order', () => {
    expect(signingProgress('out_for_signature', []).done).toEqual([true, true, false, false, false]);
    expect(signingProgress('out_for_signature', ['landlord']).current).toBe(3);
    expect(signingProgress('active', ['tenant', 'landlord'])).toEqual({ done: [true, true, true, true, true], current: 5 });
    expect(signingProgress('scheduled', ['tenant', 'landlord']).done[4]).toBe(true);
  });
});
