import { describe, expect, it } from 'vitest';
import { ageBucket, monthlyInterestCents, rentForPeriod } from '../money';

const BASE = 850000;
const START = new Date('2026-09-01');

describe('rentForPeriod', () => {
  it('holds the base rent for the whole first year', () => {
    expect(rentForPeriod(BASE, 8, START, new Date('2026-10-01'))).toBe(850000);
    expect(rentForPeriod(BASE, 8, START, new Date('2027-08-01'))).toBe(850000);
  });

  it('escalates on the anniversary, not in January', () => {
    expect(rentForPeriod(BASE, 8, START, new Date('2027-01-01'))).toBe(850000);
    expect(rentForPeriod(BASE, 8, START, new Date('2027-09-01'))).toBe(918000);
  });

  it('compounds year on year', () => {
    expect(rentForPeriod(BASE, 8, START, new Date('2028-09-01'))).toBe(991440);
  });

  it('leaves rent alone when escalation is zero', () => {
    expect(rentForPeriod(BASE, 0, START, new Date('2029-09-01'))).toBe(850000);
  });

  it('never charges less than the base for a period before the lease starts', () => {
    expect(rentForPeriod(BASE, 8, START, new Date('2026-07-01'))).toBe(850000);
  });
});

describe('ageBucket', () => {
  const today = new Date('2026-07-27');
  it('reads not-yet-due as current', () => {
    expect(ageBucket(new Date('2026-08-01'), today)).toBe('current');
    expect(ageBucket(today, today)).toBe('current');
  });
  it('walks the buckets by age', () => {
    expect(ageBucket(new Date('2026-07-17'), today)).toBe('d30');
    expect(ageBucket(new Date('2026-06-12'), today)).toBe('d60');
    expect(ageBucket(new Date('2026-05-10'), today)).toBe('d90');
    expect(ageBucket(new Date('2026-04-23'), today)).toBe('d90plus');
  });
  it('puts day 30 in the 30 bucket and day 31 in the next one', () => {
    expect(ageBucket(new Date('2026-06-27'), today)).toBe('d30');
    expect(ageBucket(new Date('2026-06-26'), today)).toBe('d60');
  });
});

describe('monthlyInterestCents', () => {
  it('posts a month of simple interest on the running balance', () => {
    expect(monthlyInterestCents(850000, 5.5)).toBe(3896);
  });
  it('posts nothing on an empty deposit', () => {
    expect(monthlyInterestCents(0, 5.5)).toBe(0);
  });
  it('rounds to the cent rather than carrying fractions', () => {
    expect(Number.isInteger(monthlyInterestCents(123457, 7.3))).toBe(true);
  });
});
