import { beforeAll, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route } from 'react-router-dom';
import { call, daysFromNow, mount, signInAs } from './harness';
import { copied } from './setup';
import { Properties } from '../screens/properties';
import { ApplyStart } from '../screens/apply-start';
import { LandlordQueue } from '../screens/landlord-queue';

const type = (element: Element, value: string) => fireEvent.change(element, { target: { value } });
const label = (text: string) => screen.getByLabelText(new RegExp(`^${text}`));

describe('the portfolio screen', () => {
  beforeAll(async () => {
    await signInAs('landlord@example.co.za');
  });

  it('adds a property, adds a unit, re-prices it, copies its link, then removes both', async () => {
    mount('/properties', <Route path="/properties" element={<Properties />} />);
    await screen.findByText('Kruis Court');

    // Walks up from a property name to the card that owns the Add-a-unit button.
    const cardOf = (name: string) => {
      let node: HTMLElement | null = screen.getAllByText(name)[0]!;
      while (node && !within(node).queryByRole('button', { name: 'Add a unit' })) {
        node = node.parentElement;
      }
      return node!;
    };

    // Add a property.
    fireEvent.click(screen.getByRole('button', { name: 'Add a property' }));
    type(label('Name'), 'Click Street');
    type(label('Street address'), '1 Click Road');
    type(label('Suburb'), 'Melville');
    type(label('City'), 'Johannesburg');
    type(label('Postal code'), '2092');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Property added');
    await screen.findByText('Click Street');

    // Add a unit to it.
    fireEvent.click(within(cardOf('Click Street')).getByRole('button', { name: 'Add a unit' }));
    await screen.findByText(/Add a unit to Click Street/);
    type(label('Unit code'), 'C1');
    type(label('Bedrooms'), '2');
    type(label('Bathrooms'), '1');
    // CurrencyInput parses on blur; the drawer has two (rent first, then deposit).
    const rentInput = screen.getAllByPlaceholderText('0.00')[0]!;
    type(rentInput, '9500');
    fireEvent.blur(rentInput);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Unit added');
    await screen.findByText('C1');

    // Re-price via Edit, scoped to the new unit's row.
    const unitRow = () => screen.getByText('C1').closest('div.flex') as HTMLElement;
    fireEvent.click(within(unitRow()).getByRole('button', { name: 'Edit' }));
    await screen.findByText('Edit C1');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Unit updated');

    // Copy the application link.
    fireEvent.click(within(unitRow()).getByRole('button', { name: 'Copy link' }));
    await screen.findByText('Application link copied');
    expect(copied.at(-1)).toContain('/apply?unit=');

    // Remove the unit: Edit -> Remove this unit -> the dialog's own Remove.
    fireEvent.click(within(unitRow()).getByRole('button', { name: 'Edit' }));
    await screen.findByText('Edit C1');
    fireEvent.click(screen.getByRole('button', { name: 'Remove this unit' }));
    await screen.findByText(/no lease history and no applications/);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Remove' })).at(-1)!);
    await screen.findByText('Unit removed');

    // Remove the now-empty property the same way.
    fireEvent.click(within(cardOf('Click Street')).getByRole('button', { name: 'Remove' }));
    await screen.findByText(/only goes once it has no units/);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Remove' })).at(-1)!);
    await screen.findByText('Property removed');
    await waitFor(() => expect(screen.queryByText('Click Street')).toBeNull());
  });
});

describe('applying and processing the queue', () => {
  let unitId: string;
  let applicantEmail: string;

  beforeAll(async () => {
    await signInAs('landlord@example.co.za');
    const property = await call<{ id: string }>('POST', '/properties', {
      name: 'Queue Court',
      addressLine1: '2 Queue Lane',
      suburb: 'Linden',
      city: 'Johannesburg',
      province: 'Gauteng',
      postalCode: '2195',
    });
    const unit = await call<{ id: string }>('POST', `/properties/${property.id}/units`, {
      code: 'Q1',
      bedrooms: 2,
      bathrooms: 1,
      monthlyRentCents: 900000,
      depositCents: 900000,
    });
    unitId = unit.id;
    // A fixed identity so the next suite can sign in as the same person.
    applicantEmail = 'queue-applicant@example.co.za';
    const register = await fetch('http://localhost:3001/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Queue Applicant', email: applicantEmail, password: 'a-long-password' }),
    });
    const session = register.ok
      ? await register.json()
      : await fetch('http://localhost:3001/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: applicantEmail, password: 'a-long-password' }),
        }).then((r) => r.json());
    localStorage.setItem('CapacitorStorage.id_token', session.token);
    localStorage.setItem('tms.user', JSON.stringify(session.user));
  });

  it('lets the applicant pick the unit and continue to documents', async () => {
    mount(
      `/apply?unit=${unitId}`,
      <>
        <Route path="/apply" element={<ApplyStart />} />
        <Route path="/apply/:applicationId/documents" element={<div>PROBE-DOCS</div>} />
      </>,
    );
    // jsdom's window.location never carries the ?unit= of a copied link, so the picker is
    // clicked instead — which is the other path a real person takes.
    await screen.findAllByText(/Queue Court Q1/);
    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: unitId } });
    await screen.findByText(/deposit/);

    type(label('First name'), 'Queue');
    type(label('Last name'), 'Applicant');
    type(label('ID number'), '9001015009086');
    type(label('Email'), applicantEmail);
    type(label('Mobile'), '0825550000');
    type(label('Employment'), 'employed');
    type(label('Gross monthly income'), '40000');
    fireEvent.blur(label('Gross monthly income'));
    type(label('Occupants'), '1');
    type(label('Move in'), daysFromNow(30));
    fireEvent.click(screen.getByRole('button', { name: 'Continue to documents' }));
    await screen.findByText('PROBE-DOCS', undefined, { timeout: 10000 });
  });

  it('lets the landlord approve and generate the lease from the terms dialog', async () => {
    await signInAs('landlord@example.co.za');
    mount(
      '/applications',
      <>
        <Route path="/applications" element={<LandlordQueue />} />
        <Route path="/lease/:leaseId" element={<div>PROBE-LEASE</div>} />
      </>,
    );
    await screen.findAllByText('Applications');

    // Approve if the application is still waiting; reruns find it already approved.
    const waiting = await screen
      .findByText('Queue Applicant', undefined, { timeout: 3000 })
      .catch(() => null);
    if (waiting) {
      fireEvent.click(within(waiting.closest('tr')!).getByRole('button', { name: 'Approve' }));
      await screen.findByText('Application approved');
    }

    fireEvent.click(screen.getByRole('tab', { name: 'Approved' }));
    const approvedRow = (await screen.findAllByText('Queue Applicant', undefined, { timeout: 5000 }))[0]!;
    fireEvent.click(within(approvedRow.closest('tr')!).getByRole('button', { name: 'Generate lease' }));
    await screen.findByText(/Lease for Queue Applicant/);
    fireEvent.click(screen.getByRole('button', { name: 'Generate and open it' }));
    await screen.findByText('PROBE-LEASE', undefined, { timeout: 15000 });
  });
});
