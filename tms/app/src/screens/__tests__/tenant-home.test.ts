import { describe, expect, it } from 'vitest';
import { applicationStatus } from '../tenant-home';

const approved = { id: 'a', status: 'approved', leaseId: 'l1' };

describe('applicationStatus', () => {
  it('says the lease ended for a former tenant, not that the landlord is preparing one', () => {
    const status = applicationStatus({ ...approved, leaseStatus: 'terminated' });
    expect(status.label).toBe('Lease ended');
    expect(status.next).not.toMatch(/preparing/);
    expect(status.link).toBeNull();
  });

  it('links to the lease once there is one to read or sign', () => {
    expect(applicationStatus({ ...approved, leaseStatus: 'out_for_signature' }).link).toEqual({
      to: '/lease/l1',
      label: 'Read and sign the lease',
    });
    expect(applicationStatus({ ...approved, leaseStatus: 'active' }).link?.to).toBe('/lease/l1');
    expect(applicationStatus({ ...approved, leaseId: null, leaseStatus: null }).next).toMatch(/preparing/);
  });
});
