import { describe, expect, it } from 'vitest';
import { taxYear, taxYearOf } from '../expense';

describe('South African tax year', () => {
  it('runs 1 March to the end of February, named for the year it ends', () => {
    expect(taxYear(2027)).toEqual({ from: '2026-03-01', to: '2027-02-28' });
  });

  it('ends on 29 February in a leap year', () => {
    expect(taxYear(2028)).toEqual({ from: '2027-03-01', to: '2028-02-29' });
  });

  it('puts February in the year ending then, and March in the next', () => {
    expect(taxYearOf('2027-02-28')).toBe(2027);
    expect(taxYearOf('2027-03-01')).toBe(2028);
  });
});
