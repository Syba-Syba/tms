import { describe, expect, it } from 'vitest';
import { currentLease, leaseDocumentBadge } from '../leases';

describe('currentLease', () => {
  it('prefers the active lease over an accepted renewal listed first', () => {
    const items = [
      { id: 'renewal', status: 'scheduled' },
      { id: 'current', status: 'active' },
    ];
    expect(currentLease(items)?.id).toBe('current');
  });

  it('falls back to the newest when nothing is active yet', () => {
    expect(currentLease([{ id: 'new', status: 'out_for_signature' }])?.id).toBe('new');
    expect(currentLease([])).toBeUndefined();
  });
});

describe('leaseDocumentBadge', () => {
  const base = { hasDocument: true, status: 'out_for_signature', source: 'online', signatures: [] as { party: string }[] };

  it('says Signed only once both parties have signed, not merely because the PDF exists', () => {
    expect(leaseDocumentBadge(base)).toEqual({ label: 'Awaiting signatures', tone: 'info' });
    expect(leaseDocumentBadge({ ...base, signatures: [{ party: 'tenant' }] })).toEqual({
      label: 'Awaiting signatures',
      tone: 'info',
    });
    expect(
      leaseDocumentBadge({ ...base, status: 'active', signatures: [{ party: 'tenant' }, { party: 'landlord' }] }),
    ).toEqual({ label: 'Signed', tone: 'success' });
  });

  it('describes leases with no document honestly', () => {
    expect(leaseDocumentBadge({ ...base, hasDocument: false, status: 'draft' })).toEqual({ label: 'Not issued', tone: 'neutral' });
    expect(leaseDocumentBadge({ ...base, hasDocument: false, status: 'active', source: 'import' })).toEqual({
      label: 'Signed on paper',
      tone: 'neutral',
    });
  });
});
