import { describe, expect, it } from 'vitest';
import { cn } from '../cn';

describe('cn', () => {
  it('keeps a text colour next to a type-scale size', () => {
    // The primary button lost its white label when text-body was read as a colour.
    expect(cn('bg-action text-ink-inverse', 'h-10 px-4 text-body')).toContain('text-ink-inverse');
    expect(cn('text-danger', 'text-meta')).toBe('text-danger text-meta');
  });

  it('still lets a later size or colour win', () => {
    expect(cn('text-body', 'text-meta')).toBe('text-meta');
    expect(cn('text-ink', 'text-danger')).toBe('text-danger');
  });
});
