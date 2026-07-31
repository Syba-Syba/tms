import { describe, expect, it } from 'vitest';
import { formatZar, normaliseSaPhone, parseSaId, stripVat } from '../sa';

describe('parseSaId', () => {
  it('rejects a wrong length', () => {
    expect(parseSaId('123').valid).toBe(false);
  });

  it('rejects a bad check digit', () => {
    expect(parseSaId('9001015800086').valid).toBe(false);
  });
});

describe('normaliseSaPhone', () => {
  it('converts a local number', () => {
    expect(normaliseSaPhone('082 123 4567')).toBe('+27821234567');
  });

  it('keeps an international number', () => {
    expect(normaliseSaPhone('+27821234567')).toBe('+27821234567');
  });

  it('returns null for rubbish', () => {
    expect(normaliseSaPhone('12')).toBeNull();
  });
});

describe('money', () => {
  it('formats rands', () => {
    expect(formatZar(1234.5)).toContain('1');
  });

  it('strips vat', () => {
    expect(stripVat(115)).toBe(100);
  });
});
