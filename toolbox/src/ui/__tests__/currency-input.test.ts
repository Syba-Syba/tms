import { describe, expect, it } from 'vitest';
import { parseCurrencyInput } from '../currency-input';

describe('parseCurrencyInput', () => {
  it('reads a thousands comma as grouping, not as the decimal point', () => {
    expect(parseCurrencyInput('8,500')).toBe(850000);
    expect(parseCurrencyInput('1,234,567')).toBe(123456700);
  });

  it('reads a decimal comma', () => {
    expect(parseCurrencyInput('8500,50')).toBe(850050);
    expect(parseCurrencyInput('12,5')).toBe(1250);
  });

  it('uses the last separator as the decimal point when both appear', () => {
    expect(parseCurrencyInput('1,234.56')).toBe(123456);
    expect(parseCurrencyInput('1.234,56')).toBe(123456);
  });

  it('reads a plain decimal point and whole numbers', () => {
    expect(parseCurrencyInput('12.5')).toBe(1250);
    expect(parseCurrencyInput('9500')).toBe(950000);
    expect(parseCurrencyInput('1.234.567')).toBe(123456700);
  });

  it('ignores currency symbols and spaces', () => {
    expect(parseCurrencyInput('R 8 500,00')).toBe(850000);
    expect(parseCurrencyInput('R8 500.00')).toBe(850000);
  });

  it('returns null for nothing', () => {
    expect(parseCurrencyInput('')).toBeNull();
    expect(parseCurrencyInput('R')).toBeNull();
  });
});
