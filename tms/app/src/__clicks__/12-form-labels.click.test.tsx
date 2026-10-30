import { describe, expect, it } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { Route } from 'react-router';
import { API, ensureLease, mount, signInAs } from './harness';
import { LeaseDetail } from '../screens/lease-detail';
import { TenantRent } from '../screens/tenant-rent';

let leaseId = '';

/** Every field in the payment forms has a name a screen reader can announce. */
describe('payment form labels', () => {
  it('names the fields of "Record a payment" on the lease', async () => {
    leaseId = await ensureLease({ signed: true });
    await signInAs('landlord@example.co.za');
    mount(`/leases/${leaseId}`, <Route path="/leases/:leaseId" element={<LeaseDetail />} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Record a payment' }));
    expect(screen.getByRole('combobox', { name: 'What this pays' })).toBeTruthy();
    expect(screen.getByLabelText('Amount')).toBeTruthy();
    expect(screen.getByLabelText('Bank reference')).toBeTruthy();
  });

  it('names the fields of the tenant\'s proof of payment', async () => {
    const tenant = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'queue-applicant@example.co.za', password: 'a-long-password' }),
    }).then((r) => r.json());
    localStorage.setItem('CapacitorStorage.id_token', tenant.token);
    localStorage.setItem('tms.user', JSON.stringify(tenant.user));
    mount(`/rent/${leaseId}`, <Route path="/rent/:leaseId" element={<TenantRent />} />);
    const send = await screen.findByRole('button', { name: 'Send proof of payment' });
    await screen.findByText(/Reference/);
    fireEvent.click(send);
    expect(screen.getByRole('combobox', { name: 'What this pays' })).toBeTruthy();
    expect(screen.getByLabelText('Reference you used')).toBeTruthy();
  });
});
