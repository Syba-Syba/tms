import { describe, expect, it } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { Route } from 'react-router';
import { call, mount, signInAs } from './harness';
import { ImportTenants } from '../screens/import-tenants';

const type = (element: Element, value: string) => fireEvent.change(element, { target: { value } });
const stamp = Date.now();

/** A landlord adds a tenant who was renting before Threshold, from the form. */
describe('adding a current tenant', () => {
  it('fills the form, adds the tenancy and finds it on the leases list', async () => {
    await signInAs('landlord@example.co.za');
    const property = await call<{ id: string }>('POST', '/properties', {
      name: `Import Court ${stamp}`, addressLine1: '1 Import Road', suburb: 'Linden', city: 'Johannesburg',
      province: 'Gauteng', postalCode: '2195',
    });
    await call('POST', `/properties/${property.id}/units`, {
      code: 'I1', bedrooms: 1, bathrooms: 1, monthlyRentCents: 550000, depositCents: 550000,
    });

    mount('/tenants/import', <Route path="/tenants/import" element={<ImportTenants />} />);
    const unit = await screen.findByLabelText('Unit');
    await screen.findByRole('option', { name: `Import Court ${stamp} I1` });
    const add = screen.getByRole('button', { name: 'Add tenancy' });
    expect(add).toBeDisabled();

    fireEvent.change(unit, { target: { value: (screen.getByRole('option', { name: `Import Court ${stamp} I1` }) as HTMLOptionElement).value } });
    type(screen.getByLabelText('First name'), 'Lerato');
    type(screen.getByLabelText('Last name'), `Imported${stamp}`);
    type(screen.getByLabelText('Email'), `lerato-${stamp}@example.co.za`);
    type(screen.getByLabelText('Mobile'), '082 765 4321');
    type(screen.getByLabelText('Lease started'), '2025-02-01');
    type(screen.getByLabelText('Lease ends'), '2027-01-31');
    // The amount is read when the field loses focus, as when someone tabs out of it.
    type(screen.getByLabelText('Rent now, a month'), '5500');
    fireEvent.blur(screen.getByLabelText('Rent now, a month'));
    fireEvent.click(add);

    await screen.findByText(`Lerato Imported${stamp} added`);
    const leases = await call<{ items: { tenant: string; status: string }[] }>('GET', '/leases');
    expect(leases.items.find((lease) => lease.tenant === `Lerato Imported${stamp}`)?.status).toBe('active');
  });
});
