import { describe, expect, it } from 'vitest';
import { currentLease } from '../leases';

describe('currentLease', () => {
  it('prefers the active lease over an accepted renewal listed first', () => {
    const items = [
      { id: 'renewal', status: 'scheduled' },
      { id: 'current', status: 'active' },
    ];
    expect(currentLease(items)?.id).toBe('current');
  });

  it('falls back to the newest when nothing is active yet', () => {
    expect(currentLease([{ id: 'new', status: 'out_for_signature' }])?.id).toBe('new');
    expect(currentLease([])).toBeUndefined();
  });
});
