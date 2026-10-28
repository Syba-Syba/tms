import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { fireEvent, screen, within } from '@testing-library/react';
import { Route } from 'react-router';
import { API, mount } from './harness';
import { NotificationPreferences } from '../screens/notification-preferences';
import { Login } from '../screens/login';
import { startSession } from '../lib/session';
import { PRIVACY_VERSION } from '../lib/privacy';
import { TERMS_VERSION } from '../lib/terms';

const type = (element: Element, value: string) => fireEvent.change(element, { target: { value } });
const stamp = Date.now();
const email = `two-step-${stamp}@example.co.za`;

/** What the phone's authenticator app would show for a step (RFC 6238, SHA1, 6 digits). */
function totp(secret: string, step: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of secret.replace(/\s/g, '')) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 15;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
const step = () => Math.floor(Date.now() / 30_000);
let secret = '';

describe('two-step sign-in', () => {
  it('turns on from Settings with a code from the scanned key, and shows the recovery codes', async () => {
    const response = await fetch(`${API}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Two Step', email, password: 'a-long-password', consentVersion: PRIVACY_VERSION,
        termsVersion: TERMS_VERSION, landlord: { tradingName: `Two Step Rentals ${stamp}`, phone: '0825550199' },
      }),
    });
    const signed = await response.json();
    await startSession(signed.token, signed.user);

    mount('/settings/notifications', <Route path="/settings/notifications" element={<NotificationPreferences />} />);
    const section = await screen.findByRole('region', { name: 'Two-step sign-in' });
    fireEvent.click(within(section).getByRole('button', { name: 'Turn on' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('img', { name: 'QR code to scan' })).toBeTruthy();
    secret = within(dialog).getByText(/^[A-Z2-7 ]{32,}$/).textContent!.replace(/\s/g, '');
    type(within(dialog).getByLabelText('Code from the app'), totp(secret, step()));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    await screen.findByText('Keep these recovery codes');
    expect(screen.getAllByText(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/)).toHaveLength(10);
  });

  it('asks for the code after the password at sign-in', async () => {
    localStorage.clear();
    mount(
      '/login',
      <>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<div>PROBE-HOME</div>} />
      </>,
    );
    type(screen.getByPlaceholderText('Email'), email);
    type(screen.getByPlaceholderText('Password'), 'a-long-password');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const code = await screen.findByLabelText('Code from your authenticator app');
    // The code used to turn it on cannot be used again, so this is the next one along.
    type(code, totp(secret, step() + 1));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText('PROBE-HOME');
  });
});
