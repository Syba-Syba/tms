import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { erasureBlock, PRIVACY_VERSION, retainedUntil } from '../privacy';

describe('retention', () => {
  it('holds records for five years after the lease ends', () => {
    expect(retainedUntil([{ status: 'terminated', endDate: '2026-01-31', terminationEffectiveOn: null }])).toBe('2031-01-31');
  });

  it('counts from an early termination, not the original end date', () => {
    expect(
      retainedUntil([{ status: 'terminated', endDate: '2027-01-31', terminationEffectiveOn: '2026-06-30' }]),
    ).toBe('2031-06-30');
  });

  it('takes the latest of several leases', () => {
    expect(
      retainedUntil([
        { status: 'terminated', endDate: '2020-01-31', terminationEffectiveOn: null },
        { status: 'active', endDate: '2027-03-31', terminationEffectiveOn: null },
      ]),
    ).toBe('2032-03-31');
  });

  it('ignores leases that never took effect', () => {
    expect(retainedUntil([{ status: 'cancelled', endDate: '2027-01-31', terminationEffectiveOn: null }])).toBeNull();
    expect(retainedUntil([])).toBeNull();
  });

  it('blocks erasure until the date, then allows it', () => {
    const leases = [{ status: 'terminated', endDate: '2020-05-31', terminationEffectiveOn: null }];
    expect(erasureBlock(leases, '2025-05-30')).toMatch(/until 2025-05-31/);
    expect(erasureBlock(leases, '2025-05-31')).toBeNull();
  });
});

describe('notice version', () => {
  it('is the same in the API and the app', () => {
    const app = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../../../app/src/lib/privacy.ts'),
      'utf8',
    );
    expect(app).toContain(`PRIVACY_VERSION = '${PRIVACY_VERSION}'`);
  });
});
