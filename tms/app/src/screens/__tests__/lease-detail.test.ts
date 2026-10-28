import { describe, expect, it } from 'vitest';
import { noticeRules } from '../lease-detail';

const TODAY = '2026-10-27';
const live = { status: 'active', endDate: '2027-04-30', renewedBy: null };

describe('noticeRules', () => {
  it('takes no notice on a lease whose renewal was accepted', () => {
    const rules = noticeRules(
      { ...live, renewedBy: { id: 'n', ref: 'LSE-00002', status: 'scheduled', startDate: '2027-05-01', signaturesOnFile: 0 } },
      'early_tenant',
      TODAY,
    );
    expect(rules).toMatchObject({ canServe: false, renewalAccepted: true });
  });

  it('caps a one-sided notice at the lease end, but not an agreed one', () => {
    expect(noticeRules(live, 'early_tenant', TODAY)).toMatchObject({ canServe: true, latestEffectiveOn: '2027-04-30' });
    expect(noticeRules(live, 'mutual', TODAY).latestEffectiveOn).toBeUndefined();
  });

  it('treats a lease past its end date as month to month', () => {
    const rules = noticeRules({ ...live, endDate: '2026-10-17' }, 'end_of_term', TODAY);
    expect(rules).toMatchObject({ canServe: true, monthToMonth: true, latestEffectiveOn: undefined });
  });
});
