import { describe, expect, it } from 'vitest';
import { cleanPercentInput, parsePercent } from '../percent';

describe('parsePercent', () => {
  it('reads a decimal comma or point', () => {
    expect(parsePercent('7,5')).toBe(7.5);
    expect(parsePercent('7.5')).toBe(7.5);
    expect(parsePercent(' 8 ')).toBe(8);
    expect(parsePercent('')).toBe(0);
  });
  it('is NaN for something that is not a number, so the API refuses it', () => {
    expect(parsePercent('abc')).toBeNaN();
  });
});

describe('cleanPercentInput', () => {
  it('turns a comma into the decimal point instead of dropping it', () => {
    expect(cleanPercentInput('7,5')).toBe('7.5');
    expect(cleanPercentInput('7.5%')).toBe('7.5');
    expect(cleanPercentInput('7.5.1')).toBe('7.51');
  });
});
