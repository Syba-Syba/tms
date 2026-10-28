import { describe, expect, it } from 'vitest';
import { leaseEndDate } from '../lease';

const iso = (date: Date) => date.toISOString().slice(0, 10);
const day = (value: string) => new Date(`${value}T00:00:00Z`);

describe('leaseEndDate', () => {
  it('ends the day before the anniversary of the start', () => {
    expect(iso(leaseEndDate(day('2026-09-01'), 12))).toBe('2027-08-31');
    expect(iso(leaseEndDate(day('2026-03-15'), 6))).toBe('2026-09-14');
  });

  it('clamps month overflow instead of spilling into the following month', () => {
    // 31 January + 1 month used to become 3 March, so the lease ended 2 March and billed
    // two days nobody lived there.
    expect(iso(leaseEndDate(day('2026-01-31'), 1))).toBe('2026-02-27');
    expect(iso(leaseEndDate(day('2024-01-31'), 1))).toBe('2024-02-28'); // leap year
    expect(iso(leaseEndDate(day('2026-08-31'), 1))).toBe('2026-09-29');
    expect(iso(leaseEndDate(day('2026-10-31'), 4))).toBe('2027-02-27');
  });

  it('is independent of the machine timezone', () => {
    // A date-only value parses as UTC midnight; a local-time setMonth shifted it by the
    // offset on any machine east or west of Greenwich.
    expect(iso(leaseEndDate(new Date('2026-02-01'), 12))).toBe('2027-01-31');
  });
});
