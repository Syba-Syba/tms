import { describe, expect, it } from 'vitest';
import { incomeCents } from '../income';

describe('incomeCents', () => {
  it('reads an income the way South Africans type it', () => {
    expect(incomeCents('25 000')).toBe(2500000);
    expect(incomeCents('25,000')).toBe(2500000);
    expect(incomeCents('25000.00')).toBe(2500000);
    expect(incomeCents('R25000')).toBe(2500000);
  });

  it('refuses what is not an amount instead of sending null', () => {
    expect(incomeCents('')).toBeNull();
    expect(incomeCents('lots')).toBeNull();
    expect(incomeCents('-500')).toBeNull();
  });
});
