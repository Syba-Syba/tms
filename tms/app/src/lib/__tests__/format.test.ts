import { describe, expect, it } from 'vitest';
import { formatDate, formatInstant } from '../format';

describe('formatInstant', () => {
  it('shows the Johannesburg day of a UTC instant, not the UTC day', () => {
    // 23:30 UTC on 6 Oct is 01:30 on 7 Oct in Johannesburg.
    expect(formatInstant('2026-10-06T23:30:00.000Z')).toBe('7 Oct 2026');
    expect(formatInstant('2026-10-07T10:00:00Z')).toBe('7 Oct 2026');
    // formatDate reads the calendar date as written, which is right only for plain dates.
    expect(formatDate('2026-10-06T23:30:00.000Z')).toBe('6 Oct 2026');
  });

  it('passes empty and unreadable values through', () => {
    expect(formatInstant(null)).toBe('');
    expect(formatInstant(undefined)).toBe('');
    expect(formatInstant('soon')).toBe('soon');
  });
});
