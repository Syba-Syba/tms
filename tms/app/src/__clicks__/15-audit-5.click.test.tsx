import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { mount, Route } from './harness';
import { addDays, localToday } from '../lib/dates';
import { LeaseDetail } from '../screens/lease-detail';
import { TenantHome } from '../screens/tenant-home';
import { InspectionRooms } from '../screens/inspection-rooms';
import { Properties } from '../screens/properties';
import { ApplyDocuments } from '../screens/apply-documents';
import { LandlordQueue } from '../screens/landlord-queue';
import { Reports } from '../screens/reports';
import { ResetPassword } from '../screens/reset-password';
import { copied } from './setup';

/**
 * Audit 5, the app's batch. Like 13 and 14, these answer from a scripted API, and each call is
 * recorded with what it sent, so a test can say what went to the server.
 */
const mock = vi.hoisted(() => ({
  routes: new Map<string, unknown>(),
  calls: [] as { key: string; body: any }[],
}));

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const respond = (method: string) => async (path: string, body?: unknown) => {
    mock.calls.push({ key: `${method} ${path}`, body });
    const route = mock.routes.get(`${method} ${path}`) ?? mock.routes.get(`${method} ${path.split('?')[0]}`);
    if (route === undefined) throw Object.assign(new Error(`No scripted answer for ${method} ${path}`), { status: 404 });
    const value = typeof route === 'function' ? await (route as (body: unknown) => unknown)(body) : route;
    return structuredClone(value);
  };
  return {
    ...actual,
    api: { get: respond('GET'), post: respond('POST'), put: respond('PUT'), patch: respond('PATCH'), delete: respond('DELETE') },
    signedUrl: async (key: string) => `https://files.test/${key}`,
  };
});

// jsdom has no canvas: an image is "re-encoded" to a fixed JPEG, and uploads are recorded.
const puts = vi.hoisted(() => [] as { blob: Blob; contentType: string }[]);
vi.mock('../lib/photos', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  photoFromFile: async () => ({ dataUrl: 'data:image/jpeg;base64,AAAA', blob: new Blob(['jpeg']), contentType: 'image/jpeg' }),
  putFile: async (_url: string, blob: Blob, contentType: string) => { puts.push({ blob, contentType }); },
}));

const on = (key: string, value: unknown) => mock.routes.set(key, value);
const callsTo = (key: string) => mock.calls.filter((call) => call.key === key);
const as = (role: 'landlord' | 'tenant') =>
  localStorage.setItem('tms.user', JSON.stringify({ sub: `sub-${role}`, role, name: role, email: `${role}@example.co.za` }));

const TODAY = localToday();

beforeEach(() => {
  mock.routes.clear();
  mock.calls.length = 0;
  puts.length = 0;
  as('landlord');
});

const baseLease = (overrides: Record<string, unknown> = {}) => ({
  id: 'l1', ref: 'LSE-00001', status: 'active', unit: 'Oak 1', tenant: 'Thandi', tenantEmail: 't@example.co.za',
  startDate: '2026-01-01', endDate: addDays(TODAY, 200), monthlyRentCents: 780000, escalationPct: 8,
  depositCents: 780000, hasDocument: true, pdfKey: null, source: 'online', tenantHasAccount: true,
  tenantInviteSentAt: null, charges: [], viewer: { isLandlord: true, isTenant: false }, inspections: [],
  termination: null, renewal: null, renewedBy: null, signatures: [],
  invoices: [
    { id: 'i-nov', period: '2026-11', dueOn: '2026-11-01', totalCents: 780000, paidCents: 0, status: 'issued', pdfKey: null },
  ],
  ...overrides,
});
const notice = (overrides: Record<string, unknown> = {}) => ({
  id: 't1', status: 'notice_served', reason: 'early_tenant', initiatedBy: 'tenant', awaitingTenant: true,
  noticeGivenOn: addDays(TODAY, -3), effectiveOn: addDays(TODAY, 40), refundDueBy: null, deductions: 0,
  statementKey: null, penaltyCents: 250000, ...overrides,
});
const asTenant = { viewer: { isLandlord: false, isTenant: true } };
const mountLease = () => mount('/leases/l1', <Route path="/leases/:leaseId" element={<LeaseDetail />} />);

describe('the tenant confirms a notice the landlord recorded (items 8, 37, 48)', () => {
  it('shows the tenant what they confirm on the lease page, and posts the confirmation', async () => {
    as('tenant');
    let confirmed = false;
    on('GET /leases/l1', () => baseLease({ ...asTenant, termination: notice({ awaitingTenant: !confirmed }) }));
    on('POST /terminations/t1/confirm', () => { confirmed = true; return { id: 't1', confirmed: true }; });
    mountLease();
    const button = await screen.findByRole('button', { name: 'Confirm the notice' });
    expect(screen.getByText(/Your landlord recorded this notice for you/)).toBeTruthy();
    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog');
    // What is being confirmed, in plain figures.
    expect(within(dialog).getByText(/Last day/)).toBeTruthy();
    expect(within(dialog).getByText(/You are leaving before the lease ends/)).toBeTruthy();
    expect(within(dialog).getByText(/R\s?2\s?500/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm the notice' }));
    await waitFor(() => expect(callsTo('POST /terminations/t1/confirm')).toHaveLength(1));
    // The lease is fetched again, and the prompt goes once it is confirmed.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Confirm the notice' })).toBeNull());
    expect(callsTo('GET /leases/l1').length).toBeGreaterThan(1);
  });

  it('is not offered to the landlord, nor once confirmed', async () => {
    on('GET /leases/l1', baseLease({ termination: notice() }));
    mountLease();
    await screen.findByText(/Notice served/);
    expect(screen.queryByRole('button', { name: 'Confirm the notice' })).toBeNull();

    as('tenant');
    on('GET /leases/l1', baseLease({ ...asTenant, termination: notice({ awaitingTenant: false }) }));
    mountLease();
    await screen.findByText(/Notice served/);
    expect(screen.queryByRole('button', { name: 'Confirm the notice' })).toBeNull();
  });

  it('puts the same prompt on the tenant’s home screen', async () => {
    as('tenant');
    on('GET /leases', {
      items: [{ id: 'l1', ref: 'LSE-00001', status: 'active', unit: 'Oak 1', startDate: '2026-01-01', endDate: addDays(TODAY, 200),
        monthlyRentCents: 780000, depositBalanceCents: 780000, depositOwingCents: 0, outstandingCents: 0, openTickets: 0,
        terminationEffectiveOn: addDays(TODAY, 40), renewalOffered: false }],
    });
    on('GET /leases/l1', baseLease({ ...asTenant, termination: notice({ reason: 'mutual', initiatedBy: 'mutual', penaltyCents: 0 }) }));
    on('POST /terminations/t1/confirm', { id: 't1', confirmed: true });
    mount('/', <Route path="/" element={<TenantHome />} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm the notice' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/You and your landlord agreed to end the lease/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm the notice' }));
    await waitFor(() => expect(callsTo('POST /terminations/t1/confirm')).toHaveLength(1));
  });
});

describe('recording a payment received earlier (item 42)', () => {
  it('sends the date the money arrived and how it was paid, and offers no future date', async () => {
    on('GET /leases/l1', baseLease());
    on('POST /leases/l1/payments', {});
    mountLease();
    fireEvent.click(await screen.findByRole('button', { name: 'Record a payment' }));
    const dialog = await screen.findByRole('dialog');
    const received = within(dialog).getByLabelText('Received on') as HTMLInputElement;
    expect(received.value).toBe(TODAY);
    expect(received.max).toBe(TODAY);
    fireEvent.change(received, { target: { value: addDays(TODAY, -3) } });
    fireEvent.change(within(dialog).getByLabelText('How it was paid'), { target: { value: 'cash' } });
    fireEvent.change(within(dialog).getByLabelText('Amount'), { target: { value: '7800' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(callsTo('POST /leases/l1/payments')).toHaveLength(1));
    expect(callsTo('POST /leases/l1/payments')[0]!.body).toMatchObject({ receivedOn: addDays(TODAY, -3), method: 'cash' });
  });
});

describe('reopening an inspection to dispute it (item 38)', () => {
  const inspection = (overrides: Record<string, unknown> = {}) => ({
    id: 'n1', kind: 'outgoing', status: 'awaiting_signatures', scheduledFor: TODAY, leaseId: 'l1', unit: 'Oak 1',
    reportKey: null, draftKey: 'drafts/n1.pdf', draftSha256: 'abc', viewer: { isLandlord: false, isTenant: true },
    signatures: [{ party: 'landlord', signedAt: '2026-11-01 10:00:00+00' }],
    findings: [{ id: 'f1', room: 'Kitchen', item: 'Sink', condition: 'damaged', note: null, photoKeys: [] }],
    ...overrides,
  });
  const mountRooms = () => mount('/inspections/n1', <Route path="/inspections/:inspectionId" element={<InspectionRooms />} />);

  it('lets the tenant reopen findings the landlord signed, after a warning, and posts it', async () => {
    as('tenant');
    let reopened = false;
    on('GET /inspections/n1', () => (reopened ? inspection({ status: 'in_progress', signatures: [], draftKey: null, draftSha256: null }) : inspection()));
    on('POST /inspections/n1/reopen', () => { reopened = true; return { status: 'in_progress', signaturesWithdrawn: ['landlord'] }; });
    mountRooms();
    fireEvent.click(await screen.findByRole('button', { name: 'Reopen to correct the findings' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/landlord’s signature is withdrawn/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reopen it' }));
    await waitFor(() => expect(callsTo('POST /inspections/n1/reopen')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reopen to correct the findings' })).toBeNull());
  });

  it('offers the landlord the same, and nobody once both have signed', async () => {
    on('GET /inspections/n1', inspection({ viewer: { isLandlord: true, isTenant: false } }));
    mountRooms();
    expect(await screen.findByRole('button', { name: 'Reopen to correct the findings' })).toBeTruthy();

    on('GET /inspections/n1', inspection({ signatures: [
      { party: 'landlord', signedAt: '2026-11-01 10:00:00+00' }, { party: 'tenant', signedAt: '2026-11-01 11:00:00+00' },
    ] }));
    mountRooms();
    await screen.findByText('Kitchen');
    expect(screen.queryByRole('button', { name: 'Reopen to correct the findings' })).toBeNull();
  });

  // Found end to end: the server refuses the tenant on an exit report the landlord signed alone
  // after a booked date the tenant missed, and the button offered it anyway.
  it('follows the server on who may reopen: not a tenant who missed the exit inspection', async () => {
    as('tenant');
    on('GET /inspections/n1', inspection({ reopenable: false }));
    mountRooms();
    await screen.findByText('Kitchen');
    expect(screen.queryByRole('button', { name: 'Reopen to correct the findings' })).toBeNull();
  });
});

describe('the apply link names the landlord (item 39)', () => {
  it('copies a link that opens this landlord’s form on the unit', async () => {
    on('GET /landlord', { account: { slug: 'oak-homes' }, me: { role: 'owner' }, teamSize: 1, onboarding: { done: true } });
    on('GET /properties', {
      items: [{ id: 'p1', name: 'Oak Court', addressLine1: '1 Oak', suburb: 'S', city: 'C', province: 'Gauteng', postalCode: '2000',
        units: [{ id: 'u1', code: 'A1', bedrooms: 1, bathrooms: 1, monthlyRentCents: 780000, depositCents: 780000, status: 'vacant',
          tenant: null, leaseId: null, leaseEnd: null, openApplications: 0, listing: { description: null, photos: [], published: false } }] }],
    });
    mount('/properties', <Route path="/properties" element={<Properties />} />);
    const button = await screen.findByRole('button', { name: 'Copy the application link for A1' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await screen.findByText('Application link copied');
    expect(copied.at(-1)).toMatch(/\/apply\?landlord=oak-homes&unit=u1$/);
  });
});

describe('application documents as PDFs (item 40)', () => {
  const mountDocs = () => {
    on('GET /applications/a1/documents', { items: [] });
    on('GET /applications/a1/credit-check', { status: 'none' });
    on('POST /applications/a1/documents/presign', { uploadUrl: 'https://files.test/up', key: 'k1' });
    on('POST /applications/a1/documents/confirm', { confirmed: true });
    mount('/apply/a1/documents', <Route path="/apply/:applicationId/documents" element={<ApplyDocuments />} />);
  };

  it('uploads a PDF bank statement as it is, labelled a PDF', async () => {
    as('tenant');
    mountDocs();
    const input = (await screen.findByLabelText('Choose a file for Three months bank statements')) as HTMLInputElement;
    expect(input.accept).toContain('application/pdf');
    const pdf = new File(['%PDF-1.4 three months'], 'statements.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [pdf] } });
    await waitFor(() => expect(callsTo('POST /applications/a1/documents/confirm')).toHaveLength(1));
    expect(callsTo('POST /applications/a1/documents/presign')[0]!.body).toMatchObject({
      kind: 'bank_statement', contentType: 'application/pdf', sizeBytes: pdf.size,
    });
    expect(puts[0]!.contentType).toBe('application/pdf');
    expect(puts[0]!.blob).toBe(pdf);
    expect(await screen.findByText('Received (PDF)')).toBeTruthy();
  });

  it('still re-encodes a photo to JPEG', async () => {
    as('tenant');
    mountDocs();
    const input = (await screen.findByLabelText('Choose a file for ID document')) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['png'], 'id.png', { type: 'image/png' })] } });
    await waitFor(() => expect(callsTo('POST /applications/a1/documents/confirm')).toHaveLength(1));
    expect(callsTo('POST /applications/a1/documents/presign')[0]!.body).toMatchObject({ kind: 'id_copy', contentType: 'image/jpeg' });
    expect(puts[0]!.contentType).toBe('image/jpeg');
  });
});

const application = (overrides: Record<string, unknown> = {}) => ({
  id: 'a1', status: 'submitted', applicant: 'Sipho', unit: 'Oak 2', submittedAt: '2026-11-01 10:00:00+00',
  preferredMoveIn: '2026-12-01', occupants: 1, monthlyRentCents: 780000, monthlyIncomeCents: 3000000,
  affordability: { ratio: 0.26, band: 'comfortable' }, documentCount: 4, leaseId: null, leaseStatus: null, ...overrides,
});

describe('an applicant with no income (item 43)', () => {
  it('says no income was declared, not 0% of income', async () => {
    // Infinity serialises as null.
    on('GET /applications', { items: [application({ monthlyIncomeCents: 0, affordability: { ratio: null, band: 'over' } })] });
    on('GET /properties', { items: [] });
    mount('/applications', <Route path="/applications" element={<LandlordQueue />} />);
    expect((await screen.findAllByText('No income declared')).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^0%/)).toBeNull();
  });
});

describe('approved applications whose lease has moved on (item 46)', () => {
  it('opens the lease page for a live or ended lease, and the signing page only while signing', async () => {
    on('GET /applications', { items: [
      application({ id: 'a1', applicant: 'Ended', status: 'approved', leaseId: 'l-ended', leaseStatus: 'terminated' }),
      application({ id: 'a2', applicant: 'Signing', status: 'approved', leaseId: 'l-sign', leaseStatus: 'out_for_signature' }),
    ] });
    on('GET /properties', { items: [] });
    mount('/applications', (
      <>
        <Route path="/applications" element={<LandlordQueue />} />
        <Route path="/leases/:leaseId" element={<div>PROBE-LEASE-DETAIL</div>} />
        <Route path="/lease/:leaseId" element={<div>PROBE-SIGNING</div>} />
      </>
    ));
    fireEvent.click(screen.getByRole('tab', { name: /^Approved/ }));
    expect((await screen.findAllByRole('button', { name: 'Continue signing' })).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('button', { name: 'Open lease' })[0]!);
    expect(await screen.findByText('PROBE-LEASE-DETAIL')).toBeTruthy();
  });
});

describe('an expense whose slip did not upload (item 44)', () => {
  it('warns, and does not then say it saved as if nothing went wrong', async () => {
    on('GET /expenses', { items: [] });
    on('GET /properties', { items: [] });
    on('GET /reports/income-expense', { totals: {}, months: [] });
    on('GET /reports/arrears', { items: [], totals: { totalCents: 0, ageing: {} } });
    on('POST /expenses', { id: 'e1', uploadUrl: 'https://files.test/up' });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).startsWith('https://files.test/')) return new Response('', { status: 500 });
      return realFetch(url, init);
    }) as typeof fetch;
    try {
      mount('/reports', <Route path="/reports" element={<Reports />} />);
      fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Expenses' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Add expense' }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.change(within(dialog).getByLabelText('Description'), { target: { value: 'Geyser repair' } });
      fireEvent.change(within(dialog).getByLabelText('Amount'), { target: { value: '3000' } });
      fireEvent.change(within(dialog).getByLabelText('Slip file'), {
        target: { files: [new File(['slip'], 'slip.pdf', { type: 'application/pdf' })] },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      await screen.findByText('Expense saved, slip not uploaded');
      // The form stays open so the slip can be tried again (see 16-redesign-records).
      expect(await within(dialog).findByRole('button', { name: 'Try the slip again' })).toBeTruthy();
      expect(screen.queryByText('Expense saved')).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('resetting a password with a quick double Enter (item 47)', () => {
  it('sends the one-use link once', async () => {
    let answer: (value: unknown) => void = () => {};
    on('POST /auth/reset/confirm', () => new Promise((resolve) => { answer = resolve; }));
    mount('/reset-password?token=abc', (
      <>
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/login" element={<div>PROBE-LOGIN</div>} />
      </>
    ));
    fireEvent.change(await screen.findByLabelText('New password'), { target: { value: 'a-long-password' } });
    const again = screen.getByLabelText('New password again');
    fireEvent.change(again, { target: { value: 'a-long-password' } });
    fireEvent.keyDown(again, { key: 'Enter' });
    fireEvent.keyDown(again, { key: 'Enter' });
    expect(callsTo('POST /auth/reset/confirm')).toHaveLength(1);
    answer({ token: null, user: null });
    expect(await screen.findByText('PROBE-LOGIN')).toBeTruthy();
    expect(screen.queryByText('Password not changed')).toBeNull();
  });
});
