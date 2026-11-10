import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { mount, Route } from './harness';
import { addDays, localToday } from '../lib/dates';
import { TenantHome } from '../screens/tenant-home';
import { TenantRent } from '../screens/tenant-rent';
import { TicketsList } from '../screens/tickets-list';
import { TicketDetail } from '../screens/ticket-detail';
import { InspectionRooms } from '../screens/inspection-rooms';
import { InspectionRoom } from '../screens/inspection-room';
import { ApplyStart } from '../screens/apply-start';
import { ApplyDocuments } from '../screens/apply-documents';
import { Login } from '../screens/login';
import { ConsentGate } from '../components/consent-gate';
import { copied, openedUrls } from './setup';

/**
 * The redesign of the tenant, applicant and signed-out screens, and the bugs fixed with it.
 * Like 13 to 15, these answer from a scripted API and record what each call sent.
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
    openDocument: async (key: string | (() => Promise<string>)) => {
      window.open(`https://files.test/${typeof key === 'string' ? key : await key()}`);
    },
  };
});

// jsdom has no canvas or camera: a photo is a fixed JPEG, and uploads are recorded.
const puts = vi.hoisted(() => [] as { blob: Blob; contentType: string }[]);
vi.mock('../lib/photos', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pickPhoto: async () => ({ dataUrl: 'data:image/jpeg;base64,AAAA', blob: new Blob(['jpeg']), contentType: 'image/jpeg' }),
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
  as('tenant');
});

const leaseRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'l1', ref: 'LSE-00001', status: 'active', unit: 'Oak 1', tenant: 'Thandi Dlamini', startDate: '2026-01-01', endDate: addDays(TODAY, 200),
  monthlyRentCents: 780000, depositBalanceCents: 780000, depositOwingCents: 0, outstandingCents: 0, openTickets: 0,
  terminationEffectiveOn: null, renewalOffered: false, ...overrides,
});

const statement = (overrides: Record<string, unknown> = {}) => ({
  reference: 'LSE-00001', landlord: 'Oak Homes',
  bank: { name: 'Capitec', holder: 'Oak Homes', accountNumber: '1234567890', branchCode: '470010' },
  bankChangedOn: null, landlordPhone: null, balanceCents: 0, depositBalanceCents: 0,
  invoices: [{ id: 'i1', period: '2026-10', dueOn: '2026-10-01', totalCents: 780000, status: 'issued' }],
  payments: [{ id: 'p1', amountCents: 100000, receivedOn: '2026-09-02', reference: 'LSE-00001' }],
  proofs: [], ...overrides,
});

describe('the tenant’s home', () => {
  it('says where they stand, with the amount and the date it is due', async () => {
    const due = addDays(TODAY, 5);
    on('GET /leases', { items: [leaseRow({ outstandingCents: 780000 })] });
    on('GET /leases/l1/statement', statement({ balanceCents: 780000, invoices: [{ id: 'i1', period: due.slice(0, 7), dueOn: due, totalCents: 780000, status: 'issued' }] }));
    mount('/', <Route path="/" element={<TenantHome />} />);
    expect(await screen.findByRole('heading', { name: /R\s?7\s?800 is due on/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Send proof of payment' })).toHaveAttribute('href', '/leases/l1/rent?proof=1');
  });

  it('says "You are paid up" when nothing is owing', async () => {
    on('GET /leases', { items: [leaseRow()] });
    on('GET /leases/l1/statement', statement({ invoices: [] }));
    mount('/', <Route path="/" element={<TenantHome />} />);
    expect(await screen.findByRole('heading', { name: 'You are paid up' })).toBeTruthy();
  });

  it('offers "This is not right" beside Confirm, and withdraws the notice', async () => {
    on('GET /leases', { items: [leaseRow({ terminationEffectiveOn: addDays(TODAY, 40) })] });
    on('GET /leases/l1', {
      id: 'l1', viewer: { isLandlord: false, isTenant: true },
      termination: { id: 't1', status: 'notice_served', reason: 'early_tenant', initiatedBy: 'tenant', awaitingTenant: true,
        noticeGivenOn: addDays(TODAY, -3), effectiveOn: addDays(TODAY, 40), penaltyCents: 0 },
    });
    on('POST /terminations/t1/withdraw', { id: 't1', status: 'withdrawn' });
    mount('/', <Route path="/" element={<TenantHome />} />);
    expect(await screen.findByRole('button', { name: 'Confirm the notice' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'This is not right' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw the notice' }));
    await waitFor(() => expect(callsTo('POST /terminations/t1/withdraw')).toHaveLength(1));
    await screen.findByText('Notice withdrawn');
  });
});

describe('a notice on the tenant’s home', () => {
  const home = (termination: Record<string, unknown>) => {
    on('GET /leases', { items: [leaseRow({ terminationEffectiveOn: termination.effectiveOn, awaitingTenant: Boolean(termination.awaitingTenant) })] });
    on('GET /leases/l1', {
      id: 'l1', viewer: { isLandlord: false, isTenant: true },
      termination: { id: 't1', status: 'notice_served', reason: 'early_tenant', initiatedBy: 'tenant', awaitingTenant: false,
        noticeGivenOn: addDays(TODAY, -30), penaltyCents: 0, attested: false, attestation: null, ...termination },
    });
    mount('/', <Route path="/" element={<TenantHome />} />);
  };

  it('shows the server’s refusal plainly when the end date passes before the confirmation lands', async () => {
    home({ awaitingTenant: true, effectiveOn: TODAY });
    on('POST /terminations/t1/confirm', () => {
      throw Object.assign(new Error('conflict'), {
        status: 409,
        body: { error: { message: 'This notice named its last day, and that has passed, so it can no longer be confirmed.' } },
      });
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm the notice' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Confirm the notice' }));
    await screen.findByText(/that has passed, so it can no longer be confirmed/);
  });

  it('does not offer Confirm once the end date has passed, and says why', async () => {
    home({ awaitingTenant: true, effectiveOn: addDays(TODAY, -2) });
    await screen.findByText('This notice can no longer be confirmed');
    expect(screen.queryByRole('button', { name: 'Confirm the notice' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'This is not right' })).toBeNull();
    expect(callsTo('POST /terminations/t1/confirm')).toHaveLength(0);
  });

  it('shows a notice the landlord attested, opens the written notice, and still lets the tenant dispute it', async () => {
    home({ effectiveOn: addDays(TODAY, 20), attested: true,
      attestation: { at: '2026-11-01 10:00:00+00', statement: 'Handed to me in writing on 1 November.', evidenceKey: 'evidence/notice.pdf' } });
    on('POST /terminations/t1/withdraw', { id: 't1', status: 'withdrawn' });
    await screen.findByText('Your landlord recorded your written notice');
    expect(screen.getByText('Handed to me in writing on 1 November.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Confirm the notice' })).toBeNull();
    const opens = openedUrls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Open the written notice' }));
    await waitFor(() => expect(openedUrls.length).toBeGreaterThan(opens));
    expect(openedUrls.at(-1)).toContain('evidence/notice.pdf');
    fireEvent.click(screen.getByRole('button', { name: 'This is not right' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Withdraw the notice' }));
    await waitFor(() => expect(callsTo('POST /terminations/t1/withdraw')).toHaveLength(1));
  });

  it('keeps the attested notice on show after its end date, without the dispute', async () => {
    home({ effectiveOn: addDays(TODAY, -1), attested: true, attestation: { at: '2026-11-01 10:00:00+00', statement: null, evidenceKey: 'evidence/notice.pdf' } });
    await screen.findByText('Your landlord recorded your written notice');
    expect(screen.getByRole('button', { name: 'Open the written notice' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'This is not right' })).toBeNull();
  });
});

describe('the tenant’s rent page', () => {
  const mountRent = (path = '/rent/l1') => mount(path, <Route path="/rent/:leaseId" element={<TenantRent />} />);

  it('counts a deposit still owing, instead of "fully paid up" (bug 3)', async () => {
    on('GET /leases/l1/statement', statement({ invoices: [], depositOwingCents: 780000 }));
    on('GET /leases/l1/arrears', null);
    mountRent();
    expect(await screen.findByText(/outstanding, including your deposit of/)).toBeTruthy();
    expect(screen.queryByText('You are fully paid up.')).toBeNull();
    expect(screen.queryByText('Paid up')).toBeNull();
    // The statement says it itself, so the lease list is not asked.
    expect(callsTo('GET /leases')).toHaveLength(0);
  });

  it('strikes through a reversed payment and gives the reason', async () => {
    on('GET /leases/l1/statement', statement({
      depositOwingCents: 0,
      payments: [
        { id: 'p1', amountCents: 780000, receivedOn: '2026-09-02', reference: 'LSE-00001', method: 'eft', reversedBy: 'p2', reversesPaymentId: null, reason: null },
        { id: 'p2', amountCents: -780000, receivedOn: '2026-09-05', reference: null, method: 'reversal', reversedBy: null, reversesPaymentId: 'p1', reason: 'Paid into the wrong lease' },
        { id: 'p3', amountCents: 100000, receivedOn: '2026-10-02', reference: 'LSE-00001', method: 'eft', reversedBy: null, reversesPaymentId: null, reason: null },
      ],
    }));
    on('GET /leases/l1/arrears', null);
    mountRent();
    const history = (await screen.findByText('Payments received')).parentElement!;
    // Two payments listed, not three: the reversal is shown on the payment it undid.
    expect(within(history).getAllByRole('listitem')).toHaveLength(2);
    const reversed = within(history).getByText(/Paid into the wrong lease/).closest('li')!;
    expect(within(reversed).getByText('Reversed')).toBeTruthy();
    expect(reversed.querySelector('s')?.textContent).toMatch(/7\s?800/);
    expect(within(history).getAllByText('Received')).toHaveLength(1);
    // Only the payment that still stands counts.
    expect(screen.getByText('1 payment received')).toBeTruthy();
  });

  it('copies the account number and the reference', async () => {
    on('GET /leases/l1/statement', statement());
    on('GET /leases/l1/arrears', null);
    mountRent();
    fireEvent.click(await screen.findByRole('button', { name: 'Copy account number' }));
    await waitFor(() => expect(copied.at(-1)).toBe('1234567890'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy reference' }));
    await waitFor(() => expect(copied.at(-1)).toBe('LSE-00001'));
  });

  it('names the month on each PDF button and in the slip form, and opens the invoice', async () => {
    on('GET /leases/l1/statement', statement({ balanceCents: 780000 }));
    on('GET /leases/l1/arrears', null);
    on('POST /invoices/i1/render', { key: 'invoices/i1.pdf' });
    mountRent();
    const opens = openedUrls.length;
    fireEvent.click(await screen.findByRole('button', { name: 'Open the October 2026 invoice as a PDF' }));
    await waitFor(() => expect(openedUrls.length).toBeGreaterThan(opens));
    expect(openedUrls.at(-1)).toContain('invoices/i1.pdf');
    // The payments history is there when the statement has one.
    expect(screen.getByText('Payments received')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Send proof of payment' }));
    const dialog = await screen.findByRole('dialog');
    const options = [...within(dialog).getByRole('combobox', { name: 'What this pays' }).querySelectorAll('option')].map((option) => option.textContent);
    expect(options).toContain('Rent for October 2026');
    expect(options.join(' ')).not.toContain('2026-10');
  });
});

describe('the repairs list', () => {
  const mountList = () =>
    mount('/tickets', (
      <>
        <Route path="/tickets" element={<TicketsList />} />
        <Route path="/leases/:leaseId/tickets/new" element={<div>PROBE-NEW-TICKET</div>} />
      </>
    ));

  it('gives a tenant with nothing reported a "Report a problem" button', async () => {
    on('GET /tickets', { items: [] });
    on('GET /leases', { items: [leaseRow()] });
    mountList();
    const empty = (await screen.findByText('Nothing outstanding')).parentElement!;
    fireEvent.click(await within(empty).findByRole('button', { name: 'Report a problem' }));
    await screen.findByText('PROBE-NEW-TICKET');
  });

  it('lets the landlord log a repair by picking a lease (bug 4)', async () => {
    as('landlord');
    on('GET /tickets', { items: [] });
    on('GET /leases', { items: [leaseRow(), leaseRow({ id: 'l2', unit: 'Oak 2', tenant: 'Kabelo Mokoena' })] });
    mountList();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Log a repair' }))[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Continue' })).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Lease' }), { target: { value: 'l2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await screen.findByText('PROBE-NEW-TICKET');
  });
});

describe('a repair, for the landlord (bug 4)', () => {
  const ticket = (overrides: Record<string, unknown> = {}) => ({
    id: 'k1', leaseId: 'l1', title: 'Leaking tap', description: 'Drips all night.', category: 'plumbing', severity: 'routine',
    status: 'in_progress', targetBy: '2026-11-17 10:00:00+00', overdue: false, unit: 'Oak 1', tenant: 'Thandi Dlamini',
    contractor: { name: 'Thabo Nkosi', trade: 'Plumber', phone: '082 777 1111' }, quoteCents: null, quoteApproved: false,
    rating: null, ratingNote: null, photos: [],
    events: [{ at: '2026-11-01 10:00:00+00', actor_role: 'tenant', kind: 'created', note: 'Leaking tap' }],
    viewer: { isLandlord: true, isTenant: false }, ...overrides,
  });
  const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const mountTicket = () => mount('/tickets/k1', <Route path="/tickets/:ticketId" element={<TicketDetail />} />);
  beforeEach(() => {
    as('landlord');
    on('GET /contractors', { items: [] });
    on('POST /tickets/k1/actions', { status: 'ok' });
  });

  it('cancels a ticket, with the reason', async () => {
    on('GET /tickets/k1', ticket());
    mountTicket();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel this repair' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Why it is cancelled'), { target: { value: 'Reported twice' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel the repair' }));
    await waitFor(() => expect(callsTo('POST /tickets/k1/actions')).toHaveLength(1));
    expect(callsTo('POST /tickets/k1/actions')[0]!.body).toEqual({ action: 'cancel', note: 'Reported twice' });
  });

  it('sends the note with a quote', async () => {
    on('GET /tickets/k1', ticket({ status: 'assigned' }));
    mountTicket();
    fireEvent.change(await screen.findByLabelText('Quote amount'), { target: { value: '1500' } });
    fireEvent.change(screen.getByLabelText('Note on the quote'), { target: { value: 'New washer and labour' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add quote' }));
    await waitFor(() => expect(callsTo('POST /tickets/k1/actions')).toHaveLength(1));
    expect(callsTo('POST /tickets/k1/actions')[0]!.body).toMatchObject({ action: 'quote', quoteCents: 150000, note: 'New washer and labour' });
  });

  it('uploads a photo of the finished work and sends the note on completion', async () => {
    on('GET /tickets/k1', ticket());
    on('POST /tickets/k1/photos/presign', { uploadUrl: 'https://files.test/up', photoId: 'ph1' });
    on('POST /photos/confirm', { confirmed: true });
    mountTicket();
    fireEvent.click(await screen.findByRole('button', { name: 'Add a photo of the work' }));
    await waitFor(() => expect(callsTo('POST /photos/confirm')).toHaveLength(1));
    expect(callsTo('POST /tickets/k1/photos/presign')[0]!.body).toMatchObject({ phase: 'completion', contentType: 'image/jpeg' });
    expect(callsTo('POST /photos/confirm')[0]!.body).toEqual({ scope: 'ticket', photoId: 'ph1' });

    fireEvent.change(screen.getByLabelText('What was done'), { target: { value: 'Washer replaced' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mark complete' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Mark complete' }));
    await waitFor(() => expect(callsTo('POST /tickets/k1/actions')).toHaveLength(1));
    expect(callsTo('POST /tickets/k1/actions')[0]!.body).toEqual({ action: 'complete', note: 'Washer replaced' });
  });

  it('closes a done ticket the tenant has not rated after 7 days, and not before', async () => {
    const done = (days: number) => ticket({
      status: 'done',
      events: [
        { at: '2026-10-01 10:00:00+00', actor_role: 'tenant', kind: 'created', note: null },
        { at: daysAgo(days), actor_role: 'landlord', kind: 'completed', note: null },
      ],
    });
    on('GET /tickets/k1', done(2));
    mountTicket();
    await screen.findByText(/Waiting for Thandi Dlamini to rate the work/);
    expect(screen.queryByRole('button', { name: 'Close without a rating' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel this repair' })).toBeNull();

    on('GET /tickets/k1', done(8));
    on('POST /tickets/k1/close', { status: 'closed' });
    mountTicket();
    fireEvent.click(await screen.findByRole('button', { name: 'Close without a rating' }));
    await waitFor(() => expect(callsTo('POST /tickets/k1/close')).toHaveLength(1));
    expect(callsTo('POST /tickets/k1/close')[0]!.body).not.toHaveProperty('rating');
  });

  it('moves the rating with the arrow keys', async () => {
    as('tenant');
    on('GET /tickets/k1', ticket({ status: 'done', viewer: { isLandlord: false, isTenant: true } }));
    mountTicket();
    const group = await screen.findByRole('radiogroup', { name: 'Rating' });
    const radios = within(group).getAllByRole('radio');
    // One stop in the tab order, like native radios.
    expect(radios.filter((radio) => radio.tabIndex === 0)).toHaveLength(1);
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(radios[1]).toHaveAttribute('aria-checked', 'true');
    expect(document.activeElement).toBe(radios[1]);
    fireEvent.keyDown(group, { key: 'End' });
    expect(radios[4]).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(radios[3]).toHaveAttribute('aria-checked', 'true');
  });
});

describe('a missed inspection (bug 8)', () => {
  const inspection = {
    id: 'n1', kind: 'outgoing', status: 'missed', scheduledFor: TODAY, leaseId: 'l1', unit: 'Oak 1',
    reportKey: null, draftKey: null, draftSha256: null, viewer: { isLandlord: true, isTenant: false }, signatures: [],
    findings: [{ id: 'f1', room: 'Kitchen', item: 'Sink', condition: 'good', note: null, photoKeys: [] }],
  };

  it('explains itself and offers nothing to prepare, sign or reopen', async () => {
    as('landlord');
    on('GET /inspections/n1', inspection);
    mount('/inspections/n1', <Route path="/inspections/:inspectionId" element={<InspectionRooms />} />);
    await screen.findByText('This inspection did not happen');
    expect(screen.queryByRole('button', { name: 'Prepare the report' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Sign as/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reopen to correct the findings' })).toBeNull();
  });

  it('does not say signing has started on its rooms', async () => {
    as('landlord');
    on('GET /inspections/n1', inspection);
    mount('/inspections/n1/room/Kitchen', <Route path="/inspections/:inspectionId/room/:room" element={<InspectionRoom />} />);
    await screen.findByText('This inspection did not happen');
    expect(screen.queryByText(/Signing has started/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save Kitchen' })).toBeNull();
    // The condition is still read out as a radio group, with the chosen one marked.
    const group = screen.getByRole('radiogroup', { name: 'Condition of Sink' });
    expect(within(group).getByRole('radio', { name: 'Good' })).toHaveAttribute('aria-checked', 'true');
  });
});

describe('applying', () => {
  it('clears a unit that is no longer available and says so (bug 12)', async () => {
    on('GET /units/available', {
      items: [{ id: 'u1', label: 'Oak 1', suburb: 'Linden', city: 'Johannesburg', bedrooms: 2, bathrooms: 1, monthlyRentCents: 780000, depositCents: 780000 }],
      landlord: { name: 'Oak Homes' }, needsLink: false,
    });
    mount('/apply?unit=gone', <Route path="/apply" element={<ApplyStart />} />);
    await screen.findByText('That unit is no longer available');
    // The picker has a name, and holds nothing the applicant cannot see.
    expect((screen.getByRole('combobox', { name: 'Unit' }) as HTMLSelectElement).value).toBe('');
    fireEvent.click(document.getElementById('application-consent')!);
    fireEvent.click(screen.getByRole('button', { name: 'Continue to documents' }));
    await waitFor(() => expect(callsTo('GET /units/available')).toHaveLength(1));
    expect(callsTo('POST /applications')).toHaveLength(0);
  });

  const mountDocs = (items: unknown[] = []) => {
    let onFile = items;
    on('GET /applications/a1/documents', () => ({ items: onFile }));
    on('GET /applications/a1/credit-check', { status: 'none' });
    on('POST /applications/a1/documents/presign', (body: any) => ({ uploadUrl: 'https://files.test/up', key: `k-${body.kind}` }));
    on('POST /applications/a1/documents/confirm', (body: any) => {
      if (body.key === 'k-other') {
        onFile = [...onFile, { id: `x${onFile.length}`, kind: 'other', contentType: 'image/jpeg', viewUrl: 'https://files.test/x' }];
      }
      return { confirmed: true };
    });
    mount('/apply/a1/documents', <Route path="/apply/:applicationId/documents" element={<ApplyDocuments />} />);
  };

  it('keeps extra pages side by side as "other" documents, and says a row holds one file (bug 2)', async () => {
    mountDocs();
    expect(await screen.findByText(/Each row above keeps one file, and a new one replaces it/)).toBeTruthy();
    const input = screen.getByLabelText('Choose an extra page');
    fireEvent.change(input, { target: { files: [new File(['page2'], 'page2.jpg', { type: 'image/jpeg' })] } });
    await screen.findByText('1 extra page on file.');
    fireEvent.change(input, { target: { files: [new File(['page3'], 'page3.jpg', { type: 'image/jpeg' })] } });
    await screen.findByText('2 extra pages on file.');
    expect(callsTo('POST /applications/a1/documents/presign').map((call) => call.body.kind)).toEqual(['other', 'other']);
  });

  it('accepts a PDF whose type is empty but whose name ends in .pdf', async () => {
    mountDocs();
    const input = await screen.findByLabelText('Choose a file for Latest payslip');
    const pdf = new File(['%PDF-1.4'], 'Payslip October.PDF', { type: '' });
    fireEvent.change(input, { target: { files: [pdf] } });
    await waitFor(() => expect(callsTo('POST /applications/a1/documents/confirm')).toHaveLength(1));
    expect(callsTo('POST /applications/a1/documents/presign')[0]!.body).toMatchObject({ kind: 'payslip', contentType: 'application/pdf' });
    expect(puts[0]!.contentType).toBe('application/pdf');
    expect(puts[0]!.blob).toBe(pdf);
    expect(await screen.findByText('Received (PDF)')).toBeTruthy();
  });

  it('names each Capture and Replace button after its document', async () => {
    mountDocs([{ id: 'd1', kind: 'id_copy', contentType: 'image/jpeg', viewUrl: 'https://files.test/id' }]);
    expect(await screen.findByRole('button', { name: 'Replace ID document' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Capture Latest payslip' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Capture Three months bank statements' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Capture Proof of address' })).toBeTruthy();
  });
});

describe('signing in', () => {
  it('offers landlord sign-up in one step, and keeps the button looking enabled', async () => {
    localStorage.clear();
    mount('/login', <Route path="/login" element={<Login />} />);
    expect(screen.getByRole('link', { name: 'I am a landlord' })).toHaveAttribute('href', '/register?as=landlord');
    expect(screen.getByRole('link', { name: 'I am applying for a place' })).toHaveAttribute('href', '/register');
    const button = screen.getByRole('button', { name: 'Sign in' });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await screen.findByText('Enter your email and your password.');
    expect(callsTo('POST /auth/login')).toHaveLength(0);
  });
});

describe('the consent gate', () => {
  it('lets someone who will not agree sign out', async () => {
    on('GET /me/privacy', { currentVersion: 'x', acceptedVersion: null, terms: null });
    on('POST /auth/logout', {});
    mount('/', <Route path="/" element={<ConsentGate><div>PROBE-INSIDE</div></ConsentGate>} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(callsTo('POST /auth/logout')).toHaveLength(1));
    await waitFor(() => expect(localStorage.getItem('tms.user')).toBeNull());
    expect(screen.queryByText('PROBE-INSIDE')).toBeNull();
  });
});
