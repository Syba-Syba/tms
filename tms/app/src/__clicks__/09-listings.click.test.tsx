import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route } from 'react-router';
import { API, call, mount } from './harness';
import { Properties } from '../screens/properties';
import { Listings } from '../screens/listings';
import { PRIVACY_VERSION } from '../lib/privacy';
import { TERMS_VERSION } from '../lib/terms';

const stamp = Date.now();
const ONE_PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** A landlord describes a vacant unit and adds a photo; anyone opens the public page and applies. */
describe('the public listings page', () => {
  let slug = '';

  it('saves the listing details from the unit drawer', async () => {
    const response = await fetch(`${API}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Listing Owner', email: `listing-${stamp}@example.co.za`, password: 'a-long-password', consentVersion: PRIVACY_VERSION,
        termsVersion: TERMS_VERSION, landlord: { tradingName: `Listing Rentals ${stamp}`, phone: '0825550909' },
      }),
    });
    const signed = await response.json();
    localStorage.setItem('CapacitorStorage.id_token', signed.token);
    localStorage.setItem('tms.user', JSON.stringify(signed.user));
    slug = (await call('GET', '/landlord')).account.slug;
    const property = await call('POST', '/properties', {
      name: 'Jacaranda Court', addressLine1: '9 Hidden Street', suburb: 'Melville', city: 'Johannesburg', province: 'Gauteng', postalCode: '2092',
    });
    const unit = await call('POST', `/properties/${property.id}/units`, {
      code: 'J1', bedrooms: 2, bathrooms: 1, monthlyRentCents: 850000, depositCents: 850000,
    });
    // The photo goes up the way the app sends it: presign, PUT, confirm.
    const presigned = await call('POST', `/units/${unit.id}/photos`, { contentType: 'image/png', sizeBytes: 70 });
    const put = await fetch(presigned.uploadUrl, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: Buffer.from(ONE_PX, 'base64') });
    expect(put.ok).toBe(true);
    await call('POST', '/photos/confirm', { scope: 'unit', photoId: presigned.photoId });

    mount('/properties', <Route path="/properties" element={<Properties />} />);
    expect(await screen.findByText(/1 photo$/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const listing = await screen.findByRole('region', { name: 'Listing' });
    expect(listing.querySelectorAll('img')).toHaveLength(1);
    fireEvent.change(within(listing).getByLabelText('Description'), { target: { value: 'Garden flat under a jacaranda.' } });
    fireEvent.change(within(listing).getByLabelText('Parking bays'), { target: { value: '1' } });
    fireEvent.click(within(listing).getByLabelText('Furnished'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Unit updated');
  });

  it('shows the unit to someone with no account, and Apply opens the application for it', async () => {
    localStorage.clear();
    mount(`/l/${slug}`, <Route path="/l/:slug" element={<Listings />} />);
    await screen.findByRole('heading', { name: `Listing Rentals ${stamp}` });
    expect(screen.getByText('Garden flat under a jacaranda.')).toBeTruthy();
    expect(screen.getByText('Furnished')).toBeTruthy();
    expect(screen.getByText(/1 parking bay/)).toBeTruthy();
    expect(screen.getByRole('img', { name: /Jacaranda Court J1, photo 1 of 1/ })).toBeTruthy();
    // The street address stays private.
    expect(screen.queryByText(/Hidden Street/)).toBeNull();
    const apply = screen.getByRole('link', { name: 'Apply for Jacaranda Court J1' });
    expect(apply.getAttribute('href')).toMatch(new RegExp(`^/apply\\?landlord=${slug}&unit=[0-9a-f-]{36}$`));
  });

  it('says plainly when a link does not work', async () => {
    mount('/l/no-such-landlord', <Route path="/l/:slug" element={<Listings />} />);
    await waitFor(() => expect(screen.getByText('This listings link does not work')).toBeTruthy());
  });
});
