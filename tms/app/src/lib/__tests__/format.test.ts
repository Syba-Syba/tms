import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime, formatInstant, toIsoInstant } from '../format';

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

describe('Postgres text timestamps', () => {
  // What `at::text` and friends send: a space, not a T, and a bare "+00" offset. Safari's
  // Date parser returns Invalid Date for it, so the screen showed the raw string.
  const PG = '2026-10-07 22:33:06.087+00';

  it('normalises them to ISO before parsing', () => {
    expect(toIsoInstant(PG)).toBe('2026-10-07T22:33:06.087+00:00');
    expect(toIsoInstant('2026-10-07 22:33:06+02')).toBe('2026-10-07T22:33:06+02:00');
    expect(toIsoInstant('2026-10-07T22:33:06.087Z')).toBe('2026-10-07T22:33:06.087Z');
  });

  it('reads them on the Johannesburg calendar and clock', () => {
    // 22:33 UTC is 00:33 the next day in Johannesburg.
    expect(formatInstant(PG)).toBe('8 Oct 2026');
    expect(formatDateTime(PG)).toBe('8 Oct 2026, 00:33');
  });

  it('falls back to the written date when the time cannot be read', () => {
    expect(formatInstant('2026-10-07 nonsense')).toBe('7 Oct 2026');
    expect(formatDateTime('2026-10-07 nonsense')).toBe('7 Oct 2026');
  });
});
