import { describe, expect, it } from 'vitest';
import { billingWindow, describeWindow, proRataCents, renewalTerms, rentForWindow } from '../renewal';

const d = (value: string) => new Date(`${value}T00:00:00Z`);
const iso = (value: Date) => value.toISOString().slice(0, 10);

const window = (period: string, start: string, end: string, terminated?: string) =>
  billingWindow({
    periodStart: d(period),
    leaseStart: d(start),
    leaseEnd: d(end),
    terminationEffectiveOn: terminated ? d(terminated) : null,
  });

describe('billingWindow', () => {
  it('covers a whole month in the middle of a lease', () => {
    const result = window('2026-10-01', '2026-09-01', '2027-08-31')!;
    expect(result.full).toBe(true);
    expect(result.days).toBe(31);
  });

  it('bills a mid-month start from the day the tenant moves in', () => {
    // This used to produce no invoice at all, so the first half month was free.
    const result = window('2026-09-01', '2026-09-15', '2027-08-31')!;
    expect(iso(result.from)).toBe('2026-09-15');
    expect(iso(result.to)).toBe('2026-09-30');
    expect(result.days).toBe(16);
    expect(result.full).toBe(false);
  });

  it('bills a mid-month end only to the day the tenant leaves', () => {
    // This used to bill the whole month, and the overcharge came off the deposit.
    const result = window('2027-09-01', '2026-09-01', '2027-09-15')!;
    expect(result.days).toBe(15);
    expect(iso(result.to)).toBe('2027-09-15');
  });

  it('stops at an early termination date ahead of the lease end', () => {
    const result = window('2026-09-01', '2026-09-01', '2027-08-31', '2026-09-20')!;
    expect(result.days).toBe(20);
  });

  it('returns nothing for a month outside the lease', () => {
    expect(window('2026-08-01', '2026-09-01', '2027-08-31')).toBeNull();
    expect(window('2027-10-01', '2026-09-01', '2027-08-31')).toBeNull();
  });

  it('handles a lease that starts and ends inside one month', () => {
    const result = window('2026-09-01', '2026-09-10', '2026-09-20')!;
    expect(result.days).toBe(11);
  });

  it('counts February by its own length', () => {
    expect(window('2027-02-01', '2026-09-01', '2027-08-31')!.daysInMonth).toBe(28);
    expect(window('2028-02-01', '2026-09-01', '2028-08-31')!.daysInMonth).toBe(29);
  });
});

describe('proRataCents', () => {
  it('charges nothing extra for a full month', () => {
    expect(proRataCents(850000, window('2026-10-01', '2026-09-01', '2027-08-31')!)).toBe(850000);
  });

  it('charges 16 of 30 days for a mid-September start', () => {
    expect(proRataCents(850000, window('2026-09-01', '2026-09-15', '2027-08-31')!)).toBe(453333);
  });

  it('uses the real length of the month, so a February day costs more', () => {
    const feb = proRataCents(850000, window('2027-02-01', '2027-02-01', '2027-02-14')!);
    const mar = proRataCents(850000, window('2027-03-01', '2027-03-01', '2027-03-14')!);
    expect(feb).toBeGreaterThan(mar);
  });

  it('never charges more than a month', () => {
    const result = window('2026-10-01', '2026-09-01', '2027-08-31')!;
    expect(proRataCents(850000, result)).toBeLessThanOrEqual(850000);
  });
});

describe('rentForWindow', () => {
  it('applies escalation and pro-rata together on a final part month', () => {
    // Year two rent is R9 180. Fifteen of thirty September days.
    const result = rentForWindow({
      baseRentCents: 850000,
      escalationPct: 8,
      leaseStart: d('2026-09-01'),
      window: window('2027-09-01', '2026-09-01', '2027-09-15')!,
    });
    expect(result).toBe(459000);
  });

  it('names the days on a part month and stays quiet on a full one', () => {
    expect(describeWindow(window('2026-09-01', '2026-09-15', '2027-08-31')!)).toContain('16 days');
    expect(describeWindow(window('2026-10-01', '2026-09-01', '2027-08-31')!)).toBe('');
  });
});

describe('renewalTerms', () => {
  const base = {
    currentEndDate: d('2027-08-31'),
    currentRentCents: 850000,
    escalationPct: 8,
    depositHeldCents: 896752,
    offeredOn: d('2027-07-01'),
  };

  it('starts the day after the current lease ends, with no gap', () => {
    const terms = renewalTerms(base);
    expect(iso(terms.newStartDate)).toBe('2027-09-01');
    expect(iso(terms.newEndDate)).toBe('2028-08-31');
  });

  it('carries the escalation into the new rent', () => {
    expect(renewalTerms(base).newRentCents).toBe(918000);
  });

  it('tops the deposit up to the new rent rather than recollecting it', () => {
    // R9 180 needed, R8 967.52 already held including interest.
    expect(renewalTerms(base).depositTopUpCents).toBe(21248);
  });

  it('never asks for a top-up when the deposit already covers the new rent', () => {
    expect(renewalTerms({ ...base, depositHeldCents: 1000000 }).depositTopUpCents).toBe(0);
  });

  it('lands a month-end lease on a month end, not the 3rd of March', () => {
    const terms = renewalTerms({ ...base, currentEndDate: d('2027-01-30'), termMonths: 1 });
    expect(iso(terms.newStartDate)).toBe('2027-01-31');
    expect(iso(terms.newEndDate)).toBe('2027-02-27');
  });

  it('never lets the response deadline fall after the new lease starts', () => {
    const terms = renewalTerms({ ...base, offeredOn: d('2027-08-25'), respondDays: 30 });
    expect(terms.respondBy.getTime()).toBeLessThanOrEqual(terms.newStartDate.getTime());
  });
});
