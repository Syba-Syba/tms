import { beforeAll, describe, expect, it } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { Route } from 'react-router';
import { API, call, ensureLease, mount, signInAs } from './harness';
import { openedUrls } from './setup';
import { TicketNew } from '../screens/ticket-new';
import { TicketDetail } from '../screens/ticket-detail';
import { LeaseDetail } from '../screens/lease-detail';
import { Termination } from '../screens/termination';
import { Documents } from '../screens/documents';

const type = (element: Element, value: string) => fireEvent.change(element, { target: { value } });
const APPLICANT = 'queue-applicant@example.co.za';

const signInApplicant = async () => {
  const session = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: APPLICANT, password: 'a-long-password' }),
  }).then((r) => r.json());
  localStorage.setItem('CapacitorStorage.id_token', session.token);
  localStorage.setItem('tms.user', JSON.stringify(session.user));
};

let leaseId: string;
let ticketId: string;



beforeAll(async () => {
  leaseId = await ensureLease({ signed: true });
});

describe('the maintenance lifecycle, clicked', () => {
  it('tenant reports the problem', async () => {
    await signInApplicant();
    mount(
      `/leases/${leaseId}/tickets/new`,
      <>
        <Route path="/leases/:leaseId/tickets/new" element={<TicketNew />} />
        <Route path="*" element={<div>PROBE-AFTER</div>} />
      </>,
    );
    type(await screen.findByLabelText(/What is it/), 'Stove plate dead');
    type(screen.getByLabelText(/Details/), 'The back left plate stopped heating this morning.');
    fireEvent.click(screen.getByRole('button', { name: /Send report/ }));
    // navigate(-1) has nowhere to go in a one-entry MemoryRouter, so the toast is the proof.
    await screen.findByText('Reported', undefined, { timeout: 10000 });
    ticketId = (await call<any>('GET', '/tickets')).items[0].id;
  });

  it('landlord assigns, starts, and completes; tenant rates it closed', async () => {
    await signInAs('landlord@example.co.za');
    mount(`/tickets/${ticketId}`, <Route path="/tickets/:ticketId" element={<TicketDetail />} />);
    await screen.findAllByText('Stove plate dead');

    type(screen.getByPlaceholderText('Name'), 'Thabo Nkosi');
    type(screen.getByPlaceholderText('Trade'), 'Electrician');
    type(screen.getByPlaceholderText('Phone'), '0827771111');
    fireEvent.click(screen.getByRole('button', { name: 'Assign' }));
    await screen.findByText('Contractor assigned');

    fireEvent.click(await screen.findByRole('button', { name: 'Start now' }));
    await screen.findByText('Work started');
    fireEvent.click(await screen.findByRole('button', { name: 'Mark complete' }));
    await screen.findByText('Marked complete');

    // The tenant rates the work to close it.
    await signInApplicant();
    const second = mount(`/tickets/${ticketId}`, <Route path="/tickets/:ticketId" element={<TicketDetail />} />);
    const scope = within(second.container);
    await scope.findByText('Rate the work to close it');
    const arches = scope.getAllByRole('button', { name: /arch|rate|[1-5]/i });
    fireEvent.click(arches[arches.length - 1]!);
    fireEvent.click(scope.getByRole('button', { name: /Close/ }));
    await scope.findByText(/closed/i, undefined, { timeout: 10000 });
  });
});

describe('the exit, clicked', () => {
  let terminationId: string;

  it('landlord records the tenant’s written early cancellation from the lease page', async () => {
    await signInAs('landlord@example.co.za');
    const before = await call<any>('GET', `/leases/${leaseId}`);
    mount(`/leases/${leaseId}`, <Route path="/leases/:leaseId" element={<LeaseDetail />} />);
    if (!before.termination) {
      fireEvent.click(await screen.findByRole('button', { name: 'Record a notice' }));
      const dialog = await screen.findByRole('dialog');
      // The case that used to be impossible: a tenant cancelling early by letter.
      fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'early_tenant' } });
      // Recording stays disabled until the landlord confirms what it does.
      expect(within(dialog).getByRole('button', { name: 'Record it' })).toBeDisabled();
      fireEvent.click(within(dialog).getByRole('checkbox'));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Record it' }));
      await screen.findByText('Notice recorded', undefined, { timeout: 8000 });
    } else {
      // A rerun meets the notice already served; the banner is the proof instead.
      await screen.findByText(/Notice served/);
    }
    const lease = await call<any>('GET', `/leases/${leaseId}`);
    terminationId = lease.termination.id;
    if (!before.termination) expect(lease.termination.reason).toBe('early_tenant');
  });

  it('shows a recorded deduction, removes it on click, and refuses early settlement', async () => {
    await call('POST', `/terminations/${terminationId}/deductions`, {
      description: 'Scuffed wall behind the couch',
      amountCents: 40000,
    });
    mount(
      `/terminations/${terminationId}`,
      <Route path="/terminations/:terminationId" element={<Termination />} />,
    );
    await screen.findByText('Scuffed wall behind the couch');

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await screen.findByText('Deduction removed');

    fireEvent.click(screen.getByRole('button', { name: 'Settle the deposit' }));
    await screen.findByText('Cannot settle yet');
  });
});

describe('the documents screen, clicked', () => {
  it('opens the signed lease and the sealed report from one place', async () => {
    await signInApplicant();
    mount('/documents', <Route path="/documents" element={<Documents />} />);
    const openButtons = await screen.findAllByRole('button', { name: 'Open' });
    const before = openedUrls.length;
    for (const button of openButtons) fireEvent.click(button);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(openedUrls.length).toBeGreaterThan(before);
    const response = await fetch(openedUrls.at(-1)!);
    expect(response.status).toBe(200);
  });
});
