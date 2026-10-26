import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import '../lib/zod-messages';

const messageFor = (schema: z.ZodType, value: unknown) => {
  const result = schema.safeParse(value);
  return result.success ? null : result.error.issues[0]!.message;
};

describe('validation messages a tenant can read', () => {
  it('words lengths, formats and choices plainly', () => {
    expect(messageFor(z.string().min(2), 'a')).toBe('At least 2 characters.');
    expect(messageFor(z.string().max(3), 'abcd')).toBe('At most 3 characters.');
    expect(messageFor(z.string().min(1), '')).toBe('Required.');
    expect(messageFor(z.number().min(1), 0)).toBe('At least 1.');
    expect(messageFor(z.string().email(), 'nope')).toBe('Enter a valid email address.');
    expect(messageFor(z.guid(), 'nope')).toBe('Not a valid id.');
    expect(messageFor(z.enum(['eft', 'cash']), 'card')).toBe('Choose one of: eft, cash.');
    expect(messageFor(z.coerce.date(), 'not a date')).toBe('Enter a valid date.');
    expect(messageFor(z.object({ name: z.string() }), {})).toBe('Required.');
  });

  it('leaves a message written on the schema alone', () => {
    expect(messageFor(z.string().min(8, 'Use at least 8 characters.'), 'x')).toBe('Use at least 8 characters.');
  });

  it('accepts the seed ids, which are well formed but not RFC versioned', () => {
    expect(z.guid().safeParse('11111111-1111-1111-1111-111111111111').success).toBe(true);
  });
});
