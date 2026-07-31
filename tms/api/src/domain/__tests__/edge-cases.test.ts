import { describe, expect, it } from 'vitest';
import { monthlyInterestCents, rentForPeriod } from '../money';
import { earliestEffectiveDate } from '../termination';

const d = (value: string) => new Date(`${value}T00:00:00Z`);
const iso = (value: Date) => value.toISOString().slice(0, 10);

/* Every case here comes from a bug found while testing, and fails if the fix is reverted. */

describe('rentForPeriod, awkward start dates', () => {
  it('escalates a 29 February lease from the March period', () => {
    const start = d('2028-02-29');
    expect(rentForPeriod(850000, 10, start, d('2029-02-01'))).toBe(850000);
    expect(rentForPeriod(850000, 10, start, d('2029-03-01'))).toBe(935000);
  });

  it('escalates a month-end lease from the first full month after the anniversary', () => {
    const start = d('2026-01-31');
    expect(rentForPeriod(850000, 10, start, d('2027-01-01'))).toBe(850000);
    expect(rentForPeriod(850000, 10, start, d('2027-02-01'))).toBe(935000);
  });

  it('reads dates in UTC so the answer does not depend on where the job runs', () => {
    // A local-time reading would put this period in the previous year west of Greenwich.
    const start = d('2026-01-01');
    expect(rentForPeriod(850000, 8, start, d('2027-01-01'))).toBe(918000);
    expect(rentForPeriod(850000, 8, start, d('2026-12-01'))).toBe(850000);
  });
});

describe('monthlyInterestCents, bad balances', () => {
  it('pays no interest on a negative balance', () => {
    expect(monthlyInterestCents(-50000, 5.5)).toBe(0);
  });
  it('pays no interest on an empty deposit or a zero rate', () => {
    expect(monthlyInterestCents(0, 5.5)).toBe(0);
    expect(monthlyInterestCents(850000, 0)).toBe(0);
  });
});

describe('earliestEffectiveDate, late notice', () => {
  it('never lands before the notice that produced it', () => {
    // The database rejects effective_on < notice_given_on, so this used to surface as a 500.
    const notice = d('2026-07-27');
    const effective = earliestEffectiveDate('early_tenant', notice, d('2026-06-30'));
    expect(effective >= notice).toBe(true);
    expect(iso(effective)).toBe('2026-07-27');
  });

  it('ends an already-expired lease on the day notice is given', () => {
    expect(iso(earliestEffectiveDate('end_of_term', d('2026-07-27'), d('2026-06-30')))).toBe('2026-07-27');
  });

  it('still honours the notice period on a lease with time left', () => {
    expect(iso(earliestEffectiveDate('early_tenant', d('2026-07-27'), d('2027-08-31')))).toBe('2026-08-25');
  });
});
