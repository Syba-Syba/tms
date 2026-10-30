import { describe, expect, it } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { Route } from 'react-router';
import { API, mount } from './harness';
import { SettingsAccount } from '../screens/settings-account';
import { startSession } from '../lib/session';
import { PRIVACY_VERSION } from '../lib/privacy';
import { TERMS_VERSION } from '../lib/terms';

const stamp = Date.now();
const type = (element: Element, value: string) => fireEvent.change(element, { target: { value } });

/** Saving one section of the account settings must not throw away edits in another. */
describe('the account settings', () => {
  it('keeps an unsaved phone number when the link is changed', async () => {
    const response = await fetch(`${API}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Settings Owner', email: `settings-${stamp}@example.co.za`, password: 'a-long-password',
        consentVersion: PRIVACY_VERSION, termsVersion: TERMS_VERSION,
        landlord: { tradingName: `Settings Rentals ${stamp}`, phone: '0825550505' },
      }),
    });
    const signed = await response.json();
    await startSession(signed.token, signed.user);

    mount('/settings/account', <Route path="/settings/account" element={<SettingsAccount />} />);
    const phone = (await screen.findByLabelText('Business phone')) as HTMLInputElement;
    expect(phone.value).toBe('0825550505');
    type(phone, '0825559999');
    type(screen.getByLabelText('Change the end of the link'), `settings-${stamp}`);
    fireEvent.click(screen.getByRole('button', { name: 'Change link' }));
    await screen.findByText('Link changed. The old one no longer works.');
    // The refetch after the save lands the new link, and leaves the phone as typed.
    await screen.findByText(new RegExp(`/settings-${stamp}$`));
    expect((screen.getByLabelText('Business phone') as HTMLInputElement).value).toBe('0825559999');
  });
});
