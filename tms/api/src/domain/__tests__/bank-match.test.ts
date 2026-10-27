import { describe, expect, it } from 'vitest';
import { referencedRefNos, suggestLease, type LeaseCandidate } from '../bank-match';

const leases: LeaseCandidate[] = [
  { leaseId: 'phiri', refNo: 101, tenantSurname: 'Phiri', owedCents: 850000, pendingProofCents: [] },
  { leaseId: 'mahlangu', refNo: 102, tenantSurname: 'Mahlangu', owedCents: 720000, pendingProofCents: [500000] },
  { leaseId: 'dlamini', refNo: 103, tenantSurname: 'Dlamini', owedCents: 0, pendingProofCents: [] },
];

describe('referencedRefNos', () => {
  it.each([
    ['RENT LSE-00101', [101]],
    ['lse 101 oct', [101]],
    ['LSE00101', [101]],
    ['LSE-101 and LSE-102', [101, 102]],
    ['ELSE 5', []],
    ['NO REF', []],
  ])('%s', (description, refs) => {
    expect(referencedRefNos(description)).toEqual(refs);
  });
});

describe('suggestLease', () => {
  it('is sure when the reference is there and the amount fits', () => {
    expect(suggestLease({ amountCents: 850000, description: 'FNB LSE-00101' }, leases)).toMatchObject({
      leaseId: 'phiri',
      confidence: 'high',
    });
  });

  it('is sure when the reference and a pending slip agree', () => {
    expect(suggestLease({ amountCents: 500000, description: 'LSE-00102' }, leases)).toMatchObject({
      leaseId: 'mahlangu',
      confidence: 'high',
    });
  });

  it('flags a referenced payment that is more than the lease owes', () => {
    expect(suggestLease({ amountCents: 900000, description: 'LSE-00101' }, leases)?.confidence).toBe('medium');
    expect(suggestLease({ amountCents: 100, description: 'LSE-00103' }, leases)?.reason).toMatch(/nothing is owed/);
  });

  it('matches a surname and exact amount with no reference', () => {
    expect(suggestLease({ amountCents: 720000, description: 'PAYMENT S MAHLANGU' }, leases)).toMatchObject({
      leaseId: 'mahlangu',
      confidence: 'medium',
    });
  });

  it('falls back to a unique amount, with low confidence', () => {
    expect(suggestLease({ amountCents: 850000, description: 'CASH DEPOSIT' }, leases)).toMatchObject({
      leaseId: 'phiri',
      confidence: 'low',
    });
  });

  it('suggests nothing when the amount is shared or unknown, or two references appear', () => {
    const twins = [...leases, { ...leases[0]!, leaseId: 'twin', refNo: 104, tenantSurname: 'Other' }];
    expect(suggestLease({ amountCents: 850000, description: 'CASH DEPOSIT' }, twins)).toBeNull();
    expect(suggestLease({ amountCents: 1, description: 'CASH DEPOSIT' }, leases)).toBeNull();
    expect(suggestLease({ amountCents: 850000, description: 'LSE-101 LSE-102' }, leases)).toBeNull();
  });
});
