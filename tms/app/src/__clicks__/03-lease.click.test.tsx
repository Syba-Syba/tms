import { beforeAll, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route } from 'react-router';
import { call, ensureLease, mount, signInAs, API } from './harness';
import { openedUrls } from './setup';
import { LeaseReview } from '../screens/lease-review';
import { LeaseDetail } from '../screens/lease-detail';
import { InspectionRooms } from '../screens/inspection-rooms';
import { InspectionRoom } from '../screens/inspection-room';

const type = (element: Element, value: string) => fireEvent.change(element, { target: { value } });

let leaseId: string;
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

const fillOtp = (scope: typeof screen = screen) => {
  for (let digit = 1; digit <= 6; digit += 1) {
    type(scope.getByLabelText(`Digit ${digit}`), String(digit));
  }
};

/** window.open fires after the signed-URL roundtrip, so wait for the capture first. */
const openedIsPdf = async (before: number) => {
  await waitFor(() => expect(openedUrls.length).toBeGreaterThan(before), { timeout: 8000 });
  const response = await fetch(openedUrls.at(-1)!);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return response.status === 200 && bytes[0] === 0x25 && bytes[1] === 0x50; // %P
};



beforeAll(async () => {
  leaseId = await ensureLease({ signed: false });
});

describe('signing the lease', () => {
  const signIfAsked = async (party: 'landlord' | 'tenant') => {
    // A rerun meets a lease that is already signed; then the active state is the assertion.
    const digit = screen.queryByLabelText('Digit 1');
    if (digit) {
      fillOtp();
      fireEvent.click(screen.getByRole('button', { name: `Sign as the ${party}` }));
      await screen.findByText('Lease signed', undefined, { timeout: 8000 });
    }
  };

  it('landlord opens the PDF and signs against its fingerprint', async () => {
    await signInAs('landlord@example.co.za');
    mount(`/lease/${leaseId}`, <Route path="/lease/:leaseId" element={<LeaseReview />} />);
    await screen.findByText('The lease');

    const opens = openedUrls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Open the lease PDF' }));
    expect(await openedIsPdf(opens)).toBe(true);

    await signIfAsked('landlord');
    await waitFor(() => {
      expect(
        screen.queryByText('Your signature is on file') ?? screen.queryByText('This lease is active'),
      ).toBeTruthy();
    }, { timeout: 8000 });
  });

  it('tenant signs and the lease goes live on screen', async () => {
    await signInApplicant();
    mount(`/lease/${leaseId}`, <Route path="/lease/:leaseId" element={<LeaseReview />} />);
    await screen.findByText('Your lease');
    await signIfAsked('tenant');
    await screen.findAllByText('This lease is active', undefined, { timeout: 10000 });
  });
});

describe('the inspection, clicked end to end', () => {
  let inspectionId: string;
  let room: string;

  it('landlord books the move-in inspection from the lease page', async () => {
    await signInAs('landlord@example.co.za');
    const before = await call<any>('GET', `/leases/${leaseId}`);
    mount(`/leases/${leaseId}`, <Route path="/leases/:leaseId" element={<LeaseDetail />} />);
    if (before.inspections.length === 0) {
      fireEvent.click(await screen.findByRole('button', { name: 'Book move-in' }));
      await screen.findByText('Move-in inspection created', undefined, { timeout: 8000 });
    }
    // Listed by its plain name, not the database's 'incoming'.
    await screen.findByText(/Move-in ·/);
    const state = await call<any>('GET', `/leases/${leaseId}`);
    inspectionId = state.inspections[0].id;
  });

  it('records a damaged item with a note in a room', async () => {
    const state = await call<any>('GET', `/inspections/${inspectionId}`);
    room = state.findings[0].room;
    if (state.status !== 'in_progress') {
      // A rerun meets a sealed inspection: the room must be read-only instead.
      mount(
        `/inspections/${inspectionId}/room/${encodeURIComponent(room)}`,
        <Route path="/inspections/:inspectionId/room/:room" element={<InspectionRoom />} />,
      );
      await screen.findByRole('button', { name: 'Back' });
      expect(screen.queryByRole('button', { name: `Save ${room}` })).toBeNull();
      return;
    }
    mount(
      `/inspections/${inspectionId}/room/${encodeURIComponent(room)}`,
      <>
        <Route path="/inspections/:inspectionId/room/:room" element={<InspectionRoom />} />
        <Route path="*" element={<div>PROBE-BACK</div>} />
      </>,
    );
    await screen.findAllByText('Good', { exact: false });

    fireEvent.click(screen.getAllByRole('tab', { name: 'Damaged' })[0]!);
    type(await screen.findByPlaceholderText('What exactly, and where'), 'Cracked during clicking');
    fireEvent.click(screen.getByRole('button', { name: `Save ${room}` }));
  });

  it('prepares the draft, both parties sign it, and the sealed report opens', async () => {
    const state = await call<any>('GET', `/inspections/${inspectionId}`);
    mount(`/inspections/${inspectionId}`, <Route path="/inspections/:inspectionId" element={<InspectionRooms />} />);
    await screen.findByText('Move-in inspection');
    if (state.status === 'completed') {
      // A rerun meets it sealed: the report button is the assertion instead.
      const reruns = openedUrls.length;
      fireEvent.click(await screen.findByRole('button', { name: 'Open the signed report' }));
      expect(await openedIsPdf(reruns)).toBe(true);
      return;
    }
    await screen.findByText('1 flagged');

    fireEvent.click(screen.getByRole('button', { name: 'Prepare the report' }));
    const opens = openedUrls.length;
    fireEvent.click(await screen.findByRole('button', { name: 'Open the report to review', }, { timeout: 8000 }));
    expect(await openedIsPdf(opens)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Sign as the landlord' }));
    await screen.findByText('Signed', undefined, { timeout: 8000 });
    await screen.findByText('Your signature is on file');

    // Tenant's turn.
    await signInApplicant();

    const second = mount(
      `/inspections/${inspectionId}`,
      <Route path="/inspections/:inspectionId" element={<InspectionRooms />} />,
    );
    await within(second.container).findByText('Move-in inspection');
    fireEvent.click(await within(second.container).findByRole('button', { name: 'Open the report to review' }));
    fireEvent.click(within(second.container).getByRole('button', { name: 'Sign as the tenant' }));
    await within(second.container).findByText('Inspection complete', undefined, { timeout: 10000 });
    const reportOpens = openedUrls.length;
    fireEvent.click(within(second.container).getByRole('button', { name: 'Open the signed report' }));
    expect(await openedIsPdf(reportOpens)).toBe(true);
  });
});
