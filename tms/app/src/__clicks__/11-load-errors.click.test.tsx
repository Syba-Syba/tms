import { describe, expect, it } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { Route } from 'react-router';
import { API, mount } from './harness';
import { Reports } from '../screens/reports';
import { Payments } from '../screens/payments';
import { startSession } from '../lib/session';

const stamp = Date.now();

/** A list that fails to load says so, rather than spinning forever or claiming it is empty. */
describe('screens whose data fails to load', () => {
  it('signs in as someone who is not a landlord', async () => {
    const response = await fetch(`${API}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Not A Landlord', email: `not-landlord-${stamp}@example.co.za`, password: 'a-long-password' }),
    });
    const signed = await response.json();
    await startSession(signed.token, signed.user);
  });

  it('shows the income report error instead of a spinner', async () => {
    mount('/reports', <Route path="/reports" element={<Reports />} />);
    expect(await screen.findByText('Not yours to see')).toBeTruthy();
  });

  it('shows the arrears report error instead of a spinner', async () => {
    mount('/reports', <Route path="/reports" element={<Reports />} />);
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Arrears' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Arrears' }));
    expect(await screen.findByText('Not yours to see')).toBeTruthy();
    // The arrears tab, not the income one behind it.
    expect(screen.queryByLabelText('Period')).toBeNull();
  });

  it('shows the slips error instead of "No slips waiting"', async () => {
    mount('/payments', <Route path="/payments" element={<Payments />} />);
    expect(await screen.findByText('Not yours to see')).toBeTruthy();
    expect(screen.queryByText('No slips waiting')).toBeNull();
  });
});
