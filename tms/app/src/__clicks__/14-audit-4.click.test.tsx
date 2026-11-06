import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider, ToastProvider } from '@hlonie/toolbox/ui';
import { mount } from './harness';
import { localToday } from '../lib/dates';
import { addDays } from '../lib/dates';
import { TicketsList } from '../screens/tickets-list';
import { LeaseDetail } from '../screens/lease-detail';
import { TenantHome } from '../screens/tenant-home';
import { LandlordQueue } from '../screens/landlord-queue';
import { Home } from '../screens/home';
import { Termination } from '../screens/termination';
import { Login } from '../screens/login';
import { Payments } from '../screens/payments';
import { Reports } from '../screens/reports';
import { PrivacyRequests } from '../components/privacy-requests';
import { TenantRent } from '../screens/tenant-rent';
import { Documents } from '../screens/documents';
import { Properties } from '../screens/properties';

/**
 * Audit 4, the app's batch. Like 13, these answer from a scripted API: the states (a notice past
 * its date, a low-confidence bank match, a dropped upload) are hard to reach on the live one.
 * Each call is recorded with what it sent, so a test can say what went to the server.
 */
const mock = vi.hoisted(() => ({
  routes: new Map<string, unknown>(),
  calls: [] as { key: string; body: any }[],
}));

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const respond = (method: string) => async (path: string, body?: unknown) => {
    mock.calls.push({ key: `${method} ${path}`, body });
    // An exact path first, then the path without its query string.
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

const on = (key: string, value: unknown) => mock.routes.set(key, value);
const callsTo = (key: string) => mock.calls.filter((call) => call.key === key);
const as = (role: 'landlord' | 'tenant') =>
  localStorage.setItem('tms.user', JSON.stringify({ sub: `sub-${role}`, role, name: role, email: `${role}@example.co.za` }));

const TODAY = localToday();

beforeEach(() => {
  mock.routes.clear();
  mock.calls.length = 0;
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
    { id: 'i-oct', period: '2026-10', dueOn: '2026-10-01', totalCents: 780000, paidCents: 0, status: 'issued', pdfKey: null },
  ],
  ...overrides,
});
const notice = (overrides: Record<string, unknown> = {}) => ({
  id: 't1', status: 'notice_served', reason: 'end_of_term', initiatedBy: 'landlord', awaitingTenant: false,
  noticeGivenOn: addDays(TODAY, -5), effectiveOn: addDays(TODAY, 40), refundDueBy: null, deductions: 0,
  statementKey: null, ...overrides,
});
const mountLease = () => mount('/leases/l1', <Route path="/leases/:leaseId" element={<LeaseDetail />} />);

describe('maintenance list (item 41)', () => {
  it('opens each ticket from its card', async () => {
    on('GET /tickets', {
      items: [{ id: 'k1', title: 'Leaking tap', category: 'plumbing', severity: 'routine', status: 'done', unit: 'Oak 1',
        contractor: null, quoteCents: null, rating: null, targetBy: '2026-11-10 10:00:00+00', overdue: false }],
    });
    mount('/tickets', <Route path="/tickets" element={<TicketsList />} />);
    expect(await screen.findByRole('link', { name: 'Leaking tap' })).toHaveAttribute('href', '/tickets/k1');
  });
});

describe('withdrawing a notice (item 43)', () => {
  it('lets the landlord withdraw their own notice, and posts the withdrawal', async () => {
    on('GET /leases/l1', baseLease({ termination: notice() }));
    on('POST /terminations/t1/withdraw', { id: 't1', status: 'withdrawn' });
    mountLease();
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw the notice' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw the notice' }));
    await waitFor(() => expect(callsTo('POST /terminations/t1/withdraw')).toHaveLength(1));
  });

  it('does not offer the tenant a withdrawal of the landlord’s notice', async () => {
    as('tenant');
    on('GET /leases/l1', baseLease({ viewer: { isLandlord: false, isTenant: true }, termination: notice() }));
    mountLease();
    await screen.findByText(/Notice served/);
    expect(screen.queryByRole('button', { name: 'Withdraw the notice' })).toBeNull();
  });

  it('lets an applicant withdraw an application still waiting', async () => {
    as('tenant');
    on('GET /leases', { items: [] });
    on('GET /me/applications', {
      items: [{ id: 'a1', status: 'submitted', submittedAt: '2026-11-01 10:00:00+00', unit: 'Oak 1', landlord: 'L', documents: 4, leaseId: null, leaseStatus: null }],
    });
    on('POST /applications/a1/withdraw', { id: 'a1', status: 'withdrawn' });
    mount('/', <Route path="/" element={<TenantHome />} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw application' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Withdraw the application' }));
    await waitFor(() => expect(callsTo('POST /applications/a1/withdraw')).toHaveLength(1));
  });

  it('lets the landlord withdraw an approved application whose lease was never signed', async () => {
    on('GET /applications', {
      items: [{ id: 'a2', status: 'approved', applicant: 'Sipho', unit: 'Oak 2', submittedAt: '2026-11-01 10:00:00+00',
        preferredMoveIn: '2026-12-01', occupants: 1, monthlyRentCents: 780000, monthlyIncomeCents: 3000000,
        affordability: { ratio: 0.26, band: 'comfortable' }, documentCount: 4, leaseId: null, leaseStatus: null }],
    });
    on('GET /properties', { items: [] });
    on('POST /applications/a2/withdraw', { id: 'a2', status: 'withdrawn' });
    mount('/applications', <Route path="/applications" element={<LandlordQueue />} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Approved' }));
    fireEvent.click((await screen.findAllByRole('button', { name: 'Withdraw' }))[0]!);
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Withdraw the application' }));
    await waitFor(() => expect(callsTo('POST /applications/a2/withdraw')).toHaveLength(1));
  });
});

describe('notice on a lease with a renewal (item 44)', () => {
  it('still takes notice while the accepted renewal is unsigned, and says it cancels it', async () => {
    as('tenant');
    on('GET /leases/l1', baseLease({
      viewer: { isLandlord: false, isTenant: true },
      renewedBy: { id: 'l2', ref: 'LSE-00002', status: 'scheduled', startDate: addDays(TODAY, 201), signaturesOnFile: 1 },
    }));
    mountLease();
    fireEvent.click(await screen.findByRole('button', { name: 'Give notice' }));
    expect(await screen.findByText(/giving notice cancels it/)).toBeTruthy();
  });

  it('takes none once the renewal is signed, and offers no second renewal', async () => {
    on('GET /leases/l1', baseLease({
      renewedBy: { id: 'l2', ref: 'LSE-00002', status: 'scheduled', startDate: addDays(TODAY, 201), signaturesOnFile: 2 },
    }));
    mountLease();
    await screen.findByText(/Renewed · LSE-00002/);
    expect(screen.queryByRole('button', { name: 'Record a notice' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Offer a renewal' })).toBeNull();
  });
});

describe('recording a notice (items 45, 55)', () => {
  it('dates a landlord’s own notice today and offers no backdating', async () => {
    on('GET /leases/l1', baseLease());
    on('POST /leases/l1/termination', { effectiveOn: addDays(TODAY, 200) });
    mountLease();
    fireEvent.click(await screen.findByRole('button', { name: 'Record a notice' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText('Date the tenant’s notice reached you')).toBeNull();
    // A tenant's written notice may carry the date it arrived.
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'early_tenant' } });
    expect(within(dialog).getByText('Date the tenant’s notice reached you')).toBeTruthy();
    fireEvent.change(within(dialog).getByDisplayValue(TODAY), { target: { value: addDays(TODAY, -10) } });
    // Switching to a notice dated today drops the earlier date rather than sending it.
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'mutual' } });
    expect(within(dialog).queryByText('Date the notice was given')).toBeNull();
    fireEvent.click(within(dialog).getByLabelText('I understand this starts the end of the tenancy'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Record it' }));
    await waitFor(() => expect(callsTo('POST /leases/l1/termination')).toHaveLength(1));
    expect(callsTo('POST /leases/l1/termination')[0]!.body).toMatchObject({ initiatedBy: 'mutual', noticeGivenOn: TODAY });
  });

  it('lets a late end-of-term notice name a date past the end date', async () => {
    on('GET /leases/l1', baseLease({ endDate: addDays(TODAY, 20) }));
    mountLease();
    fireEvent.click(await screen.findByRole('button', { name: 'Record a notice' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Fewer than 40 business days are left/)).toBeTruthy();
    const last = within(dialog).getByLabelText(/Last day/) as HTMLInputElement;
    expect(last.max > addDays(TODAY, 20)).toBe(true);
  });
});

describe('recording a payment (item 46)', () => {
  it('starts on the oldest open invoice, not the deposit', async () => {
    on('GET /leases/l1', baseLease());
    on('POST /leases/l1/payments', {});
    mountLease();
    fireEvent.click(await screen.findByRole('button', { name: 'Record a payment' }));
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByLabelText('What this pays') as HTMLSelectElement).value).toBe('i-oct');
    fireEvent.change(within(dialog).getByLabelText('Amount'), { target: { value: '7800' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(callsTo('POST /leases/l1/payments')).toHaveLength(1));
    expect(callsTo('POST /leases/l1/payments')[0]!.body).toMatchObject({ target: 'invoice', invoiceId: 'i-oct', receivedOn: TODAY });
  });

  it('waits for a choice when nothing is open', async () => {
    on('GET /leases/l1', baseLease({ invoices: [] }));
    mountLease();
    fireEvent.click(await screen.findByRole('button', { name: 'Record a payment' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Amount'), { target: { value: '7800' } });
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});

describe('an ended tenancy (item 42)', () => {
  it('keeps the deposit statement on the lease page after settlement', async () => {
    on('GET /leases/l1', baseLease({ status: 'terminated', termination: notice({ status: 'settled', statementKey: 'statements/t1.pdf' }) }));
    mountLease();
    expect(await screen.findByRole('button', { name: 'Deposit statement' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Deposit settlement' })).toHaveAttribute('href', '/terminations/t1');
  });

  it('shows a former tenant their documents rather than nothing', async () => {
    as('tenant');
    on('GET /leases', { items: [{ id: 'l1', ref: 'LSE-00001', status: 'terminated' }] });
    on('GET /leases/l1', baseLease({ status: 'terminated', termination: notice({ status: 'settled', statementKey: 'statements/t1.pdf' }) }));
    mount('/documents', <Route path="/documents" element={<Documents />} />);
    expect(await screen.findByText('Deposit statement')).toBeTruthy();
    expect(callsTo('GET /leases')[0]!.body).toMatchObject({ query: { include: 'ended' } });
  });
});

describe('the landlord’s dashboard (items 47, 52, 53, 60)', () => {
  const row = (overrides: Record<string, unknown>) => ({
    id: 'l1', ref: 'LSE-00001', status: 'active', unit: 'Oak 1', tenant: 'Thandi', startDate: '2026-01-01',
    endDate: addDays(TODAY, 200), monthlyRentCents: 780000, depositBalanceCents: 780000, outstandingCents: 0,
    overdueCents: 0, previousLeaseId: null, terminationId: null, openTickets: 0, terminationEffectiveOn: null,
    renewalOffered: false, ...overrides,
  });
  const quiet = () => {
    on('GET /payment-proofs', { items: [] });
    on('GET /applications', { items: [] });
    on('GET /bank-imports', { items: [] });
    on('GET /tickets', { items: [] });
    on('GET /reports/arrears', { items: [] });
    on('GET /privacy-requests', { items: [] });
    on('GET /reports/income-expense', { months: [] });
  };

  it('does not count rent not yet due as behind', async () => {
    quiet();
    on('GET /leases', { items: [row({ outstandingCents: 780000, overdueCents: 0 })] });
    mount('/', <Route path="/" element={<Home />} />);
    await screen.findByText('Overview');
    expect(screen.queryByText(/behind on rent/)).toBeNull();
    expect(screen.queryByText(/Thandi owes/)).toBeNull();
    expect(screen.getAllByText(/not yet due/).length).toBeGreaterThan(0);
  });

  it('asks for the deposit to be settled once a notice’s end date has passed', async () => {
    quiet();
    on('GET /leases', { items: [row({ terminationEffectiveOn: addDays(TODAY, -3), terminationId: 't1' })] });
    mount('/', <Route path="/" element={<Home />} />);
    const task = await screen.findByRole('link', { name: /Settle the deposit for Oak 1/ });
    expect(task).toHaveAttribute('href', '/terminations/t1');
  });

  it('waits for the tenant instead of asking to settle a notice they have not confirmed', async () => {
    quiet();
    on('GET /leases', {
      items: [row({ terminationEffectiveOn: addDays(TODAY, -3), terminationId: 't1', awaitingTenant: true })],
    });
    mount('/', <Route path="/" element={<Home />} />);
    await screen.findByRole('link', { name: /waiting for the tenant to confirm the notice/ });
    expect(screen.queryByRole('link', { name: /Settle the deposit for Oak 1/ })).toBeNull();
  });

  it('does not prompt a renewal for a lease already renewed, nor count the renewal as running', async () => {
    quiet();
    on('GET /leases', {
      items: [
        row({ id: 'l2', ref: 'LSE-00002', status: 'scheduled', previousLeaseId: 'l1', startDate: addDays(TODAY, 31) }),
        row({ endDate: addDays(TODAY, 30) }),
      ],
    });
    mount('/', <Route path="/" element={<Home />} />);
    expect(await screen.findByText('1 lease running.')).toBeTruthy();
    expect(screen.queryByText(/Offer a renewal, or plan the exit/)).toBeNull();
  });

  it('does not offer an agent Erase or Refuse on a privacy request', async () => {
    on('GET /landlord', { account: {}, me: { role: 'agent' }, teamSize: 2, onboarding: { done: true } });
    on('GET /privacy-requests', {
      items: [{ id: 'p1', name: 'Lerato', email: null, note: null, status: 'pending', createdAt: '2026-11-01 10:00:00+00', response: null, blockedBecause: null }],
    });
    mount('/', <Route path="/" element={<PrivacyRequests />} />);
    expect(await screen.findByText('Only the account owner can answer this request.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Erase' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Refuse with reason' })).toBeNull();
  });
});

describe('settling the deposit (items 49, 50, 61, 64)', () => {
  const comparison = {
    status: 'reconciling', statementKey: null,
    deductions: [{ id: 'd1', description: 'Lounge · Wall', amountCents: 100000, findingId: 'f2', evidenceKey: null }],
    items: [{ room: 'Lounge', item: 'Door', incoming: { condition: 'good' }, outgoing: { condition: 'damaged' },
      findingId: 'f1', noBaseline: false, notReinspected: false, worsenedBy: 3, deductible: true }],
    summary: { unchanged: 0, wearAndTear: 0, deductible: 1, noBaseline: 0, notReinspected: 0 },
  };
  const figures = (restoredOn?: string) => ({
    heldCents: 820000, deductionsCents: 100000, arrearsCents: 0, penaltyCents: 0, rentCreditCents: 200000,
    refundCents: 920000, tenantOwesCents: 0, refundRule: 'with_deductions', blocker: null,
    effectiveOn: addDays(TODAY, -30), refundDueBy: addDays(restoredOn ?? TODAY, 14),
  });

  it('lets the landlord say when repairs finished, and settles on that date', async () => {
    on('GET /terminations/t1/comparison', comparison);
    on('GET /terminations/t1/settlement', figures());
    on('POST /terminations/t1/settle', {
      depositCents: 800000, interestCents: 20000, heldCents: 820000, deductionsCents: 100000, arrearsCents: 0,
      penaltyCents: 0, rentCreditCents: 200000, refundCents: 920000, tenantOwesCents: 0, refundRule: 'with_deductions',
      refundDueBy: addDays(TODAY, -6), statementKey: null,
    });
    mount('/terminations/t1', <Route path="/terminations/:terminationId" element={<Termination />} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Settle the deposit' }));
    const dialog = await screen.findByRole('dialog');
    const date = (await within(dialog).findByLabelText('Repairs finished on')) as HTMLInputElement;
    expect(date.min).toBe(addDays(TODAY, -30));
    expect(date.max).toBe(TODAY);
    const restored = addDays(TODAY, -20);
    fireEvent.change(date, { target: { value: restored } });
    await waitFor(() =>
      expect(callsTo('GET /terminations/t1/settlement').some((call) => call.body?.query?.restoredOn === restored)).toBe(true),
    );
    const confirm = within(dialog).getByRole('button', { name: 'Settle and end the lease' });
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    await screen.findByText('Deposit settled');
    expect(callsTo('POST /terminations/t1/settle')[0]!.body).toEqual({ restoredOn: restored });
    // Item 50: the breakdown names the rent credit the refund includes.
    expect(screen.getByText(/Plus rent paid in advance/)).toBeTruthy();
  });

  it('holds Confirm while reopened figures are still loading', async () => {
    on('GET /terminations/t1/comparison', comparison);
    let release: () => void = () => {};
    on('GET /terminations/t1/settlement', () => figures());
    mount('/terminations/t1', <Route path="/terminations/:terminationId" element={<Termination />} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Settle the deposit' }));
    let dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Refund to the tenant');
    fireEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    on('GET /terminations/t1/settlement', () => new Promise((resolve) => { release = () => resolve(figures()); }));
    fireEvent.click(screen.getByRole('button', { name: 'Settle the deposit' }));
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText('Refund to the tenant')).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Settle and end the lease' })).toBeDisabled();
    release();
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Settle and end the lease' })).toBeEnabled());
  });

  it('keeps the repairs date usable while a date is typed, and starts afresh when reopened', async () => {
    on('GET /terminations/t1/comparison', comparison);
    // The server refuses a day before the end date or after today, as the real one does.
    on('GET /terminations/t1/settlement', (body: { query?: { restoredOn?: string } } | undefined) => {
      const day = body?.query?.restoredOn;
      if (day && (day < addDays(TODAY, -30) || day > TODAY)) throw new Error('restoredOn out of range');
      return figures(day);
    });
    mount('/terminations/t1', <Route path="/terminations/:terminationId" element={<Termination />} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Settle the deposit' }));
    let dialog = await screen.findByRole('dialog');
    let date = (await within(dialog).findByLabelText('Repairs finished on')) as HTMLInputElement;
    // Chrome fires each step of a typed year as a full date: 0002-..., then 0020-...
    fireEvent.change(date, { target: { value: '0002-11-06' } });
    date = within(dialog).getByLabelText('Repairs finished on') as HTMLInputElement;
    expect(date.value).toBe('0002-11-06');
    expect(within(dialog).getByRole('button', { name: 'Settle and end the lease' })).toBeDisabled();
    expect(callsTo('GET /terminations/t1/settlement').some((call) => call.body?.query?.restoredOn === '0002-11-06')).toBe(false);
    const restored = addDays(TODAY, -10);
    fireEvent.change(date, { target: { value: restored } });
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Settle and end the lease' })).toBeEnabled(),
    );
    // Cancel and reopen: the dialog forgets the chosen day.
    fireEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const before = callsTo('GET /terminations/t1/settlement').length;
    fireEvent.click(screen.getByRole('button', { name: 'Settle the deposit' }));
    dialog = await screen.findByRole('dialog');
    date = (await within(dialog).findByLabelText('Repairs finished on')) as HTMLInputElement;
    expect(date.value).toBe(TODAY);
    expect(callsTo('GET /terminations/t1/settlement').slice(before).every((call) => !call.body?.query?.restoredOn)).toBe(true);
  });

  it('names each deduction amount field', async () => {
    on('GET /terminations/t1/comparison', comparison);
    mount('/terminations/t1', <Route path="/terminations/:terminationId" element={<Termination />} />);
    expect(await screen.findByLabelText('Deduction amount for Lounge Door')).toBeTruthy();
  });
});

describe('signing in (items 51, 59)', () => {
  const renderLogin = (client: QueryClient) =>
    render(
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <ToastProvider>
            <MemoryRouter initialEntries={['/login']}>
              <Routes>
                <Route path="/login" element={<Login />} />
                <Route path="/" element={<p>home</p>} />
              </Routes>
            </MemoryRouter>
          </ToastProvider>
        </ThemeProvider>
      </QueryClientProvider>,
    );

  it('drops everything cached for whoever was signed in before', async () => {
    const client = new QueryClient();
    client.setQueryData(['leases'], { items: [{ id: 'someone-elses' }] });
    on('POST /auth/login', { token: 'tok', user: { sub: 'sub-tenant', role: 'tenant', name: 'T', email: 't@example.co.za' } });
    renderLogin(client);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 't@example.co.za' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText('home');
    expect(client.getQueryData(['leases'])).toBeUndefined();
  });

  it('sends one sign-in for Enter pressed twice', async () => {
    let answer: (value: unknown) => void = () => {};
    on('POST /auth/login', () => new Promise((resolve) => { answer = resolve; }));
    renderLogin(new QueryClient());
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 't@example.co.za' } });
    const password = screen.getByLabelText('Password');
    fireEvent.change(password, { target: { value: 'secret' } });
    fireEvent.keyDown(password, { key: 'Enter' });
    fireEvent.keyDown(password, { key: 'Enter' });
    fireEvent.keyDown(password, { key: 'Enter' });
    expect(callsTo('POST /auth/login')).toHaveLength(1);
    answer({ token: 'tok', user: { sub: 'sub-tenant', role: 'tenant', name: 'T', email: 't@example.co.za' } });
    await screen.findByText('home');
  });
});

describe('matching a bank statement (item 56)', () => {
  it('leaves a low-confidence guess out of the bulk confirm', async () => {
    on('GET /payment-proofs', { items: [] });
    on('GET /reports/arrears', { items: [], totals: { totalCents: 0 } });
    on('GET /reports/income-expense', { totals: { invoicedCents: 0, collectedCents: 0 } });
    on('GET /bank-imports', { items: [{ id: 'b1', fileName: 'oct.csv', importedAt: '2026-11-01 10:00:00+00', lines: 2, unmatched: 2, matched: 0 }] });
    on('GET /bank-imports/b1', {
      id: 'b1', fileName: 'oct.csv',
      leases: [{ leaseId: 'l1', label: 'Oak 1, Thandi', owedCents: 780000 }, { leaseId: 'l2', label: 'Oak 2, Sipho', owedCents: 780000 }],
      lines: [
        { id: 'n1', postedOn: '2026-11-01', amountCents: 780000, description: 'LSE-00001 RENT', status: 'unmatched', leaseId: null,
          suggestion: { leaseId: 'l1', confidence: 'high', reason: 'Reference matches' } },
        { id: 'n2', postedOn: '2026-11-01', amountCents: 780000, description: 'PAYMENT', status: 'unmatched', leaseId: null,
          suggestion: { leaseId: 'l2', confidence: 'low', reason: 'Amount only' } },
      ],
    });
    mount('/payments', <Route path="/payments" element={<Payments />} />);
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Bank import' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    expect(await screen.findByRole('button', { name: 'Confirm 1 matched line' })).toBeTruthy();
  });
});

describe('an expense whose slip upload drops (item 57)', () => {
  it('is not created twice when saved again', async () => {
    on('GET /expenses', { items: [] });
    on('GET /properties', { items: [] });
    on('GET /reports/income-expense', { totals: {}, months: [] });
    on('GET /reports/arrears', { items: [], totals: { totalCents: 0, ageing: {} } });
    on('POST /expenses', { id: 'e1', uploadUrl: 'https://files.test/up' });
    on('PUT /expenses/e1', {});
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).startsWith('https://files.test/')) throw new TypeError('Failed to fetch');
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
      expect(screen.queryByText('Not saved')).toBeNull();
      expect(callsTo('POST /expenses')).toHaveLength(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('the tenant’s proof of payment (item 62)', () => {
  it('forgets the chosen file when the modal is closed', async () => {
    as('tenant');
    on('GET /leases/l1/statement', {
      reference: 'REF1', landlord: 'L', bank: null, bankChangedOn: null, landlordPhone: null,
      balanceCents: 780000, depositBalanceCents: 0,
      invoices: [{ id: 'i1', period: '2026-10', dueOn: '2026-10-01', totalCents: 780000, status: 'issued' }],
      payments: [], proofs: [],
    });
    on('GET /leases/l1/arrears', null);
    mount('/rent/l1', <Route path="/rent/:leaseId" element={<TenantRent />} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send proof of payment' }));
    let dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Amount paid'), { target: { value: '7800' } });
    fireEvent.change(within(dialog).getByLabelText('Slip file'), {
      target: { files: [new File(['slip'], 'slip.pdf', { type: 'application/pdf' })] },
    });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Send' })).toBeEnabled());
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Send proof of payment' }));
    dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Amount paid'), { target: { value: '7800' } });
    expect(within(dialog).getByRole('button', { name: 'Send' })).toBeDisabled();
  });
});

describe('a charge changed on the lease page (item 58)', () => {
  it('marks the money views on other screens stale', async () => {
    const charge = { id: 'c1', period: TODAY.slice(0, 7), kind: 'utility', description: 'Water', amountCents: 25000, billed: false };
    on('GET /leases/l1', baseLease({ charges: [charge] }));
    on('DELETE /leases/l1/charges/c1', {});
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Views other screens cached before the landlord came here.
    client.setQueryData(['leases'], { items: [] });
    client.setQueryData(['report-arrears'], { items: [] });
    render(
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <ToastProvider>
            <MemoryRouter initialEntries={['/leases/l1']}>
              <Routes><Route path="/leases/:leaseId" element={<LeaseDetail />} /></Routes>
            </MemoryRouter>
          </ToastProvider>
        </ThemeProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /^Remove Water/ }));
    await screen.findByText('Charge removed');
    await waitFor(() => {
      expect(client.getQueryState(['leases'])?.isInvalidated).toBe(true);
      expect(client.getQueryState(['report-arrears'])?.isInvalidated).toBe(true);
    });
  });
});

describe('money fields with names (item 64)', () => {
  it('names the rent and deposit fields in the unit drawer', async () => {
    on('GET /properties', {
      items: [{ id: 'p1', name: 'Oak Court', addressLine1: '1 Oak', suburb: 'S', city: 'C', province: 'Gauteng', postalCode: '2000', units: [] }],
    });
    mount('/properties', <Route path="/properties" element={<Properties />} />);
    fireEvent.click(await screen.findByRole('button', { name: /Add a unit/i }));
    expect(await screen.findByLabelText('Monthly rent')).toBeTruthy();
    expect(screen.getByLabelText('Deposit')).toBeTruthy();
  });
});
