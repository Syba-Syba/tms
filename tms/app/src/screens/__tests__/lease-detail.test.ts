import { describe, expect, it } from 'vitest';
import { canWithdrawNotice, noticeRules, payableInvoices } from '../lease-detail';
import { addBusinessDays } from '../../lib/business-days';
import { addDays } from '../../lib/dates';

const TODAY = '2026-10-27';
const live = { status: 'active', endDate: '2027-04-30', renewedBy: null };

describe('noticeRules', () => {
  it('takes no notice on a lease whose renewal is signed (audit 4, item 44)', () => {
    const rules = noticeRules(
      { ...live, renewedBy: { id: 'n', ref: 'LSE-00002', status: 'scheduled', startDate: '2027-05-01', signaturesOnFile: 2 } },
      'early_tenant',
      TODAY,
    );
    expect(rules).toMatchObject({ canServe: false, renewalAccepted: true, renewalUnsigned: false });
  });

  it('takes notice on a lease whose accepted renewal is not signed, which cancels it (item 44)', () => {
    const rules = noticeRules(
      { ...live, renewedBy: { id: 'n', ref: 'LSE-00002', status: 'scheduled', startDate: '2027-05-01', signaturesOnFile: 1 } },
      'early_tenant',
      TODAY,
    );
    expect(rules).toMatchObject({ canServe: true, renewalAccepted: false, renewalUnsigned: true });
  });

  it('lets a late landlord end-of-term notice run past the end date (item 55)', () => {
    // 2026-12-01 is well under 40 business days from 2026-10-27.
    const late = noticeRules({ ...live, endDate: '2026-12-01' }, 'end_of_term', TODAY, { initiatedBy: 'landlord' });
    expect(late.landlordLate).toBe(true);
    expect(late.latestEffectiveOn! > '2026-12-01').toBe(true);
    // The same notice from the tenant, or with plenty of time left, still ends by the end date.
    expect(noticeRules({ ...live, endDate: '2026-12-01' }, 'end_of_term', TODAY, { initiatedBy: 'tenant' }).latestEffectiveOn).toBe('2026-12-01');
    expect(noticeRules(live, 'end_of_term', TODAY, { initiatedBy: 'landlord' })).toMatchObject({ landlordLate: false, latestEffectiveOn: '2027-04-30' });
  });

  it('reads month to month from the date the notice was given, not today (item 55)', () => {
    const rules = noticeRules({ ...live, endDate: '2026-10-20' }, 'early_tenant', TODAY, { initiatedBy: 'tenant', givenOn: '2026-10-15' });
    expect(rules.monthToMonth).toBe(false);
  });

  it('caps a one-sided notice at the lease end, and an agreed one a month after it (audit 5, item 45)', () => {
    expect(noticeRules(live, 'early_tenant', TODAY)).toMatchObject({ canServe: true, latestEffectiveOn: '2027-04-30' });
    expect(noticeRules(live, 'mutual', TODAY).latestEffectiveOn).toBe('2027-05-31');
  });

  it('treats a lease past its end date as month to month, capped as the server caps it (item 45)', () => {
    const rules = noticeRules({ ...live, endDate: '2026-10-17' }, 'end_of_term', TODAY);
    expect(rules).toMatchObject({ canServe: true, monthToMonth: true, latestEffectiveOn: addDays(addBusinessDays(TODAY, 20), 31) });
    // An agreed end on a run-out lease may be today, so the cap runs from today.
    expect(noticeRules({ ...live, endDate: '2026-10-17' }, 'mutual', TODAY).latestEffectiveOn).toBe('2026-11-27');
  });
});

describe('payableInvoices', () => {
  it('offers only issued and part-paid invoices for a payment, never void or paid ones', () => {
    const invoices = [
      { id: 'a', status: 'issued' },
      { id: 'b', status: 'part_paid' },
      { id: 'c', status: 'void' },
      { id: 'd', status: 'paid' },
    ];
    expect(payableInvoices(invoices).map((invoice) => invoice.id)).toEqual(['a', 'b']);
  });
});

describe('canWithdrawNotice (audit 4, item 43)', () => {
  const lease = (initiatedBy: 'tenant' | 'landlord' | 'mutual', viewer: 'landlord' | 'tenant', extra = {}) => ({
    status: 'active',
    viewer: { isLandlord: viewer === 'landlord', isTenant: viewer === 'tenant' },
    termination: {
      id: 't', status: 'notice_served', effectiveOn: '2026-12-31', noticeGivenOn: '2026-10-01', refundDueBy: null,
      deductions: 0, statementKey: null, initiatedBy, awaitingTenant: false, ...extra,
    },
  });

  it('offers it only to the party who gave the notice, and to either for an unconfirmed mutual one', () => {
    expect(canWithdrawNotice(lease('landlord', 'landlord'), TODAY)).toBe(true);
    expect(canWithdrawNotice(lease('landlord', 'tenant'), TODAY)).toBe(false);
    expect(canWithdrawNotice(lease('tenant', 'tenant'), TODAY)).toBe(true);
    expect(canWithdrawNotice(lease('tenant', 'landlord'), TODAY)).toBe(false);
    expect(canWithdrawNotice(lease('mutual', 'tenant', { awaitingTenant: true }), TODAY)).toBe(true);
    expect(canWithdrawNotice(lease('mutual', 'landlord', { awaitingTenant: true }), TODAY)).toBe(true);
  });

  it('offers neither party a confirmed mutual notice, which the server refuses (audit 5, e2e)', () => {
    expect(canWithdrawNotice(lease('mutual', 'tenant'), TODAY)).toBe(false);
    expect(canWithdrawNotice(lease('mutual', 'landlord'), TODAY)).toBe(false);
  });

  it('stops on the end date and once settled, except for a tenant who never confirmed', () => {
    expect(canWithdrawNotice(lease('landlord', 'landlord'), '2026-12-31')).toBe(false);
    expect(canWithdrawNotice(lease('landlord', 'landlord', { status: 'settled' }), TODAY)).toBe(false);
    expect(canWithdrawNotice(lease('tenant', 'tenant', { awaitingTenant: true }), '2027-01-05')).toBe(true);
  });

  it('lets the landlord undo a tenant notice they recorded that the tenant has not confirmed', () => {
    expect(canWithdrawNotice(lease('tenant', 'landlord', { awaitingTenant: true }), TODAY)).toBe(true);
    expect(canWithdrawNotice(lease('tenant', 'landlord', { awaitingTenant: true }), '2027-01-05')).toBe(true);
    expect(canWithdrawNotice(lease('tenant', 'landlord', { awaitingTenant: false }), TODAY)).toBe(false);
  });
});
