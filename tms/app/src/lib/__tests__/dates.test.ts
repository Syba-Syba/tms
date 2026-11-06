import { afterEach, describe, expect, it, vi } from 'vitest';
import { localToday } from '../dates';
import { daysUntil } from '../format';

describe('today for legal dates (audit 4, item 54)', () => {
  const zone = process.env.TZ;
  afterEach(() => {
    vi.useRealTimers();
    process.env.TZ = zone;
  });

  it('is the Johannesburg date, whatever zone the device is set to', () => {
    process.env.TZ = 'UTC';
    // 01:00 on 6 November in Johannesburg is still 5 November in UTC.
    vi.useFakeTimers({ now: new Date('2026-11-05T23:00:00Z') });
    expect(localToday()).toBe('2026-11-06');
    expect(daysUntil('2026-11-06')).toBe(0);
  });

  it('is the Johannesburg date for a device behind UTC', () => {
    process.env.TZ = 'America/New_York';
    vi.useFakeTimers({ now: new Date('2026-11-06T03:30:00Z') });
    expect(localToday()).toBe('2026-11-06');
  });
});
