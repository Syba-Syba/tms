import { z } from 'zod';

/**
 * zod 4's own wording reaches tenants in toasts ("Too small: expected string to have >=2
 * characters", "Invalid GUID"). These replace it everywhere. A message written on the schema
 * itself still wins; this only covers the ones left to the default.
 */
const unit = (origin: string) =>
  origin === 'string' ? ' characters' : origin === 'array' || origin === 'set' ? ' items' : '';

export function friendlyMessage(issue: z.core.$ZodRawIssue): string | undefined {
  switch (issue.code) {
    case 'invalid_type':
      if (issue.input === undefined || issue.input === null) return 'Required.';
      if (issue.expected === 'date') return 'Enter a valid date.';
      return `Expected a ${issue.expected}.`;
    case 'too_small': {
      const min = Number(issue.minimum);
      if (issue.origin === 'string' && min === 1) return 'Required.';
      return `${issue.inclusive === false ? 'More than' : 'At least'} ${min}${unit(issue.origin)}.`;
    }
    case 'too_big':
      return `${issue.inclusive === false ? 'Less than' : 'At most'} ${Number(issue.maximum)}${unit(issue.origin)}.`;
    case 'invalid_format':
      if (issue.format === 'email') return 'Enter a valid email address.';
      if (issue.format === 'guid' || issue.format === 'uuid') return 'Not a valid id.';
      if (issue.format === 'date' || issue.format === 'datetime') return 'Enter a valid date.';
      return 'Not in the expected format.';
    case 'invalid_value':
      return `Choose one of: ${issue.values.map(String).join(', ')}.`;
    case 'not_multiple_of':
      return `Must be a multiple of ${String(issue.divisor)}.`;
    case 'unrecognized_keys':
      return `Unexpected field${issue.keys.length === 1 ? '' : 's'}: ${issue.keys.join(', ')}.`;
    case 'invalid_union':
      return 'Not one of the accepted shapes.';
    default:
      return undefined;
  }
}

z.config({ customError: friendlyMessage });
