import { describe, expect, it } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { Route } from 'react-router';
import { API, mount } from './harness';
import { SettingsBilling } from '../screens/settings-billing';
import { startSession } from '../lib/session';
import { PRIVACY_VERSION } from '../lib/privacy';
import { TERMS_VERSION } from '../lib/terms';

const stamp = Date.now();

/** A landlord on the trial picks a plan and pays through the simulated PayFast. */
describe('choosing a plan', () => {
  it('shows the trial, takes the first payment and shows the plan as paid', async () => {
    const response = await fetch(`${API}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Plan Picker', email: `plan-${stamp}@example.co.za`, password: 'a-long-password', consentVersion: PRIVACY_VERSION,
        termsVersion: TERMS_VERSION, landlord: { tradingName: `Plan Rentals ${stamp}`, phone: '0825550404' },
      }),
    });
    const signed = await response.json();
    await startSession(signed.token, signed.user);

    mount('/settings/billing', <Route path="/settings/billing" element={<SettingsBilling />} />);
    await screen.findByText(/^Free trial until/);
    fireEvent.click(screen.getByRole('button', { name: 'Choose Starter' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Pay the first month' }));
    await screen.findByText(/^Starter plan, paid until/);
    expect(screen.getByRole('button', { name: 'Your plan' })).toBeDisabled();
    // The payment comes with its own numbered invoice, listed with its PDF.
    const invoices = await screen.findByRole('region', { name: 'Invoices' });
    expect(invoices.textContent).toMatch(/Invoice \d{4,}/);
    expect(invoices.textContent).toContain('PDF');
  });
});
