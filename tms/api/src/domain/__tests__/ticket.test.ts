import { describe, expect, it } from 'vitest';
import { canMove, SLA_HOURS, targetBy } from '../ticket';

describe('targetBy', () => {
  const from = new Date('2026-07-27T10:00:00Z');
  it('gives an emergency 24 hours', () => {
    expect(targetBy('emergency', from).toISOString()).toBe('2026-07-28T10:00:00.000Z');
  });
  it('gives routine work a week', () => {
    expect(targetBy('routine', from).toISOString()).toBe('2026-08-03T10:00:00.000Z');
  });
  it('keeps the severities ordered', () => {
    expect(SLA_HOURS.emergency).toBeLessThan(SLA_HOURS.urgent);
    expect(SLA_HOURS.urgent).toBeLessThan(SLA_HOURS.routine);
  });
});

describe('canMove', () => {
  it('allows the quoted path and the trusted-contractor shortcut', () => {
    expect(canMove('assigned', 'quote_pending')).toBe(true);
    expect(canMove('assigned', 'in_progress')).toBe(true);
    expect(canMove('quote_pending', 'quote_approved')).toBe(true);
  });
  it('refuses to skip the work', () => {
    expect(canMove('open', 'done')).toBe(false);
    expect(canMove('assigned', 'closed')).toBe(false);
  });
  it('only closes from done', () => {
    expect(canMove('done', 'closed')).toBe(true);
    expect(canMove('in_progress', 'closed')).toBe(false);
  });
  it('treats closed and cancelled as terminal', () => {
    expect(canMove('closed', 'open')).toBe(false);
    expect(canMove('cancelled', 'in_progress')).toBe(false);
  });
});
