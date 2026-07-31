import { describe, expect, it } from 'vitest';
import { TEMPLATES, inQuietHours, isMandatory, render, sendAfter } from '../notification';

const at = (utc: string) => new Date(`${utc}Z`);

describe('templates', () => {
  it('puts the amount and the reference in the rent notice', () => {
    const message = render('invoice_issued', {
      period: '2026-10', amount: 'R 8 500.00', dueOn: '2026-10-01',
      reference: 'LSE-00184', unit: 'Kruis Court A1',
    });
    expect(message.subject).toContain('R 8 500.00');
    expect(message.body).toContain('LSE-00184');
    expect(message.category).toBe('money');
  });

  it('throws rather than sending a tenant the word undefined', () => {
    expect(() => render('invoice_issued', { period: '2026-10' })).toThrow(/missing "amount"/);
  });

  it('refuses an unknown template instead of sending an empty message', () => {
    expect(() => render('not_a_template', {})).toThrow(/No notification template/);
  });

  it('marks the things worth waking someone for as urgent', () => {
    expect(TEMPLATES.ticket_raised!.urgent).toBe(true);
    expect(TEMPLATES.sla_breached!.urgent).toBe(true);
    expect(TEMPLATES.refund_due_soon!.urgent).toBe(true);
    expect(TEMPLATES.invoice_issued!.urgent).toBe(false);
  });

  it('warns about the consequence of skipping an exit inspection', () => {
    const message = render('notice_served', {
      unit: 'Kruis Court A1', noticeGivenOn: '2026-07-27', effectiveOn: '2026-08-31',
    });
    expect(message.body).toContain('nothing can be deducted');
  });
});

describe('quiet hours, South African time', () => {
  it('treats 22:00 and 03:00 local as quiet', () => {
    expect(inQuietHours(at('2026-07-27T20:00:00'))).toBe(true); // 22:00 SAST
    expect(inQuietHours(at('2026-07-27T01:00:00'))).toBe(true); // 03:00 SAST
  });

  it('treats the working day as loud', () => {
    expect(inQuietHours(at('2026-07-27T07:00:00'))).toBe(false); // 09:00 SAST
    expect(inQuietHours(at('2026-07-27T15:00:00'))).toBe(false); // 17:00 SAST
  });

  it('holds a routine message until 07:00 the next morning', () => {
    const queued = sendAfter(at('2026-07-27T20:30:00'), false); // 22:30 SAST
    expect(queued.toISOString()).toBe('2026-07-28T05:00:00.000Z'); // 07:00 SAST
  });

  it('holds an early-hours message until the same morning', () => {
    const queued = sendAfter(at('2026-07-28T02:00:00'), false); // 04:00 SAST
    expect(queued.toISOString()).toBe('2026-07-28T05:00:00.000Z');
  });

  it('sends an urgent message straight away, at any hour', () => {
    const now = at('2026-07-27T23:10:00');
    expect(sendAfter(now, true)).toEqual(now);
  });

  it('leaves a daytime message alone', () => {
    const now = at('2026-07-27T09:00:00');
    expect(sendAfter(now, false)).toEqual(now);
  });
});

describe('preferences', () => {
  it('does not let anyone switch off a statutory deadline', () => {
    expect(isMandatory('deadline')).toBe(true);
    expect(isMandatory('money')).toBe(false);
  });
});
