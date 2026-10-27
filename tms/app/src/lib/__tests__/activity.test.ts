import { describe, expect, it } from 'vitest';
import { describeAction } from '../activity';

describe('describeAction', () => {
  it('names known actions in plain words', () => {
    expect(describeAction('auth.login_failed')).toBe('Failed sign-in attempt');
    expect(describeAction('termination.notice_served')).toBe('Notice recorded');
  });

  it('still reads sensibly for an action it does not know', () => {
    expect(describeAction('ticket.approve_quote')).toBe('Ticket: approve quote');
  });
});
