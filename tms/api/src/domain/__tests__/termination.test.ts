import { describe, expect, it } from 'vitest';
import {
  addBusinessDays,
  earliestEffectiveDate,
  isBusinessDay,
  pickRefundRule,
  publicHolidays,
  reconcile,
  refundDueBy,
} from '../termination';

const d = (value: string) => new Date(`${value}T00:00:00Z`);
const iso = (value: Date) => value.toISOString().slice(0, 10);

describe('publicHolidays', () => {
  it('moves Easter with the year', () => {
    // Easter Sunday 2027 falls on 28 March, so Good Friday is the 26th.
    expect(publicHolidays(2027).has('2027-03-26')).toBe(true);
    expect(publicHolidays(2026).has('2026-04-03')).toBe(true);
  });
  it('shifts a Sunday holiday onto the Monday', () => {
    // Human Rights Day 2027 falls on a Sunday, so Monday the 22nd is a holiday too.
    const days = publicHolidays(2027);
    expect(days.has('2027-03-21')).toBe(true);
    expect(days.has('2027-03-22')).toBe(true);
  });

  it('does not invent a day when the Monday is already a holiday', () => {
    // Christmas 2033 is a Sunday and Boxing Day already owns the Monday. South Africa
    // gazetted an extra day the last time this happened; the Act alone does not.
    const days = publicHolidays(2033);
    expect(days.has('2033-12-25')).toBe(true);
    expect(days.has('2033-12-26')).toBe(true);
    expect(days.has('2033-12-27')).toBe(false);
  });

  it('honours a proclaimed holiday that no rule derives', () => {
    expect(publicHolidays(2016).has('2016-12-27')).toBe(true);
  });
});

describe('isBusinessDay', () => {
  it('rejects weekends', () => {
    expect(isBusinessDay(d('2026-07-25'))).toBe(false);
    expect(isBusinessDay(d('2026-07-26'))).toBe(false);
    expect(isBusinessDay(d('2026-07-27'))).toBe(true);
  });
  it('rejects a public holiday on a weekday', () => {
    expect(isBusinessDay(d('2026-06-16'))).toBe(false);
  });
});

describe('addBusinessDays', () => {
  it('starts counting the day after notice', () => {
    expect(iso(addBusinessDays(d('2026-07-27'), 1))).toBe('2026-07-28');
  });
  it('steps over a weekend', () => {
    expect(iso(addBusinessDays(d('2026-07-27'), 5))).toBe('2026-08-03');
  });
  it('gives 20 business days from a late July notice', () => {
    // Women's Day falls on Sunday 9 August, so Monday the 10th is observed and pushes this out.
    expect(iso(addBusinessDays(d('2026-07-27'), 20))).toBe('2026-08-25');
  });
  it('skips a public holiday inside the run', () => {
    // 9 August 2026 is a Sunday, so Monday the 10th is the observed holiday.
    expect(iso(addBusinessDays(d('2026-08-07'), 1))).toBe('2026-08-11');
  });
});

describe('earliestEffectiveDate', () => {
  const leaseEnd = d('2027-08-31');
  it('ends a full-term lease on its end date', () => {
    expect(iso(earliestEffectiveDate('end_of_term', d('2027-07-01'), leaseEnd))).toBe('2027-08-31');
  });
  it('gives an early cancellation its 20 business days', () => {
    expect(iso(earliestEffectiveDate('early_tenant', d('2026-07-27'), leaseEnd))).toBe('2026-08-25');
  });
  it('never runs past the lease end date', () => {
    expect(iso(earliestEffectiveDate('early_tenant', d('2027-08-20'), leaseEnd))).toBe('2027-08-31');
  });
});

describe('refund deadlines', () => {
  it('uses 7 calendar days when nothing is deducted', () => {
    expect(iso(refundDueBy('no_deductions', d('2027-08-31')))).toBe('2027-09-07');
  });
  it('uses 14 calendar days from restoration when there are deductions', () => {
    expect(iso(refundDueBy('with_deductions', d('2027-09-10')))).toBe('2027-09-24');
  });
  it('uses 21 calendar days when the landlord never inspected', () => {
    expect(iso(refundDueBy('no_inspection', d('2027-08-31')))).toBe('2027-09-21');
  });
  it('counts calendar days, so weekends do not extend it', () => {
    expect(iso(refundDueBy('no_deductions', d('2027-09-03')))).toBe('2027-09-10');
  });
  it('picks the rule from the facts', () => {
    expect(pickRefundRule({ outgoingInspectionCompleted: false, deductionCount: 3 })).toBe('no_inspection');
    expect(pickRefundRule({ outgoingInspectionCompleted: true, deductionCount: 0 })).toBe('no_deductions');
    expect(pickRefundRule({ outgoingInspectionCompleted: true, deductionCount: 2 })).toBe('with_deductions');
  });
});

describe('reconcile', () => {
  const base = { depositCents: 850000, interestCents: 46752, deductionsCents: 0, arrearsCents: 0, penaltyCents: 0 };

  it('refunds the deposit and its interest when nothing is claimed', () => {
    const result = reconcile(base);
    expect(result.heldCents).toBe(896752);
    expect(result.refundCents).toBe(896752);
    expect(result.tenantOwesCents).toBe(0);
  });

  it('subtracts deductions, arrears and penalty', () => {
    const result = reconcile({ ...base, deductionsCents: 320000, arrearsCents: 85000, penaltyCents: 42500 });
    expect(result.refundCents).toBe(449252);
  });

  it('turns an overdrawn deposit into a debt, never a negative refund', () => {
    const result = reconcile({ ...base, deductionsCents: 1200000 });
    expect(result.refundCents).toBe(0);
    expect(result.tenantOwesCents).toBe(303248);
  });

  it('balances exactly to zero without owing anything', () => {
    const result = reconcile({ ...base, deductionsCents: 896752 });
    expect(result.refundCents).toBe(0);
    expect(result.tenantOwesCents).toBe(0);
  });
});
