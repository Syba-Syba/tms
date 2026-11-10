import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route as RouterRoute, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider, ToastProvider } from '@hlonie/toolbox/ui';
import { mount, Route } from './harness';
import { addDays, localToday } from '../lib/dates';
import { landlordEndOfTermServableFrom } from '../lib/business-days';
import { formatDate } from '../lib/format';
import { Home } from '../screens/home';
import { LeaseDetail } from '../screens/lease-detail';
import { Termination } from '../screens/termination';

/**
 * The redesign of the Overview, the lease page and the deposit settlement, and the audit 6 fixes
 * that went with it. As in 13 to 15, the API is scripted and every call is recorded.
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

// Uploads are recorded, not sent: what matters is the file and type that would go up.
const puts = vi.hoisted(() => [] as { url: string; blob: Blob; contentType: string }[]);
vi.mock('../lib/photos', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  putFile: async (url: string, blob: Blob, contentType: string) => { puts.push({ url, blob, contentType }); },
}));

const on = (key: string, value: unknown) => mock.routes.set(key, value);
const callsTo = (key: string) => mock.calls.filter((call) => call.key === key);
const as = (role: 'landlord' | 'tenant') =>
  localStorage.setItem('tms.user', JSON.stringify({ sub: `sub-${role}`, role, name: 'Lerato Mokoena', email: `${role}@example.co.za` }));

const TODAY = localToday();

beforeEach(() => {
  mock.routes.clear();
  mock.calls.length = 0;
  puts.length = 0;
  as('landlord');
});

const baseLease = (overrides: Record<string, unknown> = {}) => ({
  id: 'l1', ref: 'LSE-00001', status: 'active', unit: 'Oak 1', tenant: 'Thandi Dlamini', tenantEmail: 't@example.co.za',
  startDate: addDays(TODAY, -165), endDate: addDays(TODAY, 200), monthlyRentCents: 780000, escalationPct: 8,
  depositCents: 780000, hasDocument: true, pdfKey: null, source: 'online', tenantHasAccount: true,
  tenantInviteSentAt: null, charges: [], viewer: { isLandlord: true, isTenant: false }, inspections: [],
  termination: null, renewal: null, renewedBy: null, signatures: [],
  invoices: [
    { id: 'i-nov', period: 'November 2026', dueOn: addDays(TODAY, 5), totalCents: 780000, paidCents: 0, status: 'issued', pdfKey: 'invoices/i-nov.pdf' },
  ],
  ...overrides,
});
const notice = (overrides: Record<string, unknown> = {}) => ({
  id: 't1', status: 'notice_served', reason: 'early_tenant', initiatedBy: 'tenant', awaitingTenant: false,
  noticeGivenOn: addDays(TODAY, -3), effectiveOn: addDays(TODAY, 25), refundDueBy: null, deductions: 0,
  statementKey: null, penaltyCents: 0, ...overrides,
});
const mountLease = (path = '/leases/l1') => mount(path, <Route path="/leases/:leaseId" element={<LeaseDetail />} />);

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'l1', ref: 'LSE-00001', status: 'active', unit: 'Oak 1', tenant: 'Thandi Dlamini', startDate: '2026-01-01',
  endDate: addDays(TODAY, 200), monthlyRentCents: 780000, depositBalanceCents: 780000, outstandingCents: 0,
  overdueCents: 0, previousLeaseId: null, terminationId: null, openTickets: 0, terminationEffectiveOn: null,
  renewalOffered: false, ...overrides,
});
const quietHome = () => {
  on('GET /payment-proofs', { items: [] });
  on('GET /applications', { items: [] });
  on('GET /bank-imports', { items: [] });
  on('GET /tickets', { items: [] });
  on('GET /reports/arrears', { items: [] });
  on('GET /privacy-requests', { items: [] });
  on('GET /reports/income-expense', { months: [{ month: TODAY.slice(0, 7), invoicedCents: 3120000, collectedCents: 780000 }] });
  on('GET /properties', { items: [{ units: [{ status: 'occupied' }, { status: 'occupied' }, { status: 'vacant' }] }] });
};
const mountHome = () =>
  mount('/', (
    <>
      <Route path="/" element={<Home />} />
      <Route path="/leases/:leaseId" element={<LeaseDetail />} />
    </>
  ));

describe('the Overview (bug 5 and the redesign)', () => {
  it('says the tenant has not confirmed the notice even when the exit inspection is also due', async () => {
    quietHome();
    on('GET /leases', {
      items: [row({ terminationEffectiveOn: addDays(TODAY, 20), terminationId: 't1', awaitingTenant: true })],
    });
    mountHome();
    // A 20 business day notice is about four weeks out: the reminder used to hide behind this task.
    expect(await screen.findByRole('link', { name: /waiting for the tenant to confirm the notice/ })).toHaveAttribute('href', '/leases/l1');
    expect(screen.getByRole('link', { name: /Oak 1 ends .* Book the exit inspection/ })).toBeTruthy();
  });

  it('greets the landlord, and puts the month in four tiles with the overdue rent first', async () => {
    quietHome();
    on('GET /leases', { items: [row({ outstandingCents: 780000, overdueCents: 780000 }), row({ id: 'l2', ref: 'LSE-00002', unit: 'Oak 2', tenant: 'Kabelo Mokoena' })] });
    mountHome();
    expect(await screen.findByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening), Lerato$/ })).toBeTruthy();
    const month = screen.getByRole('region', { name: 'This month' });
    expect(within(month).getByRole('link', { name: /Overdue rent R\s?7\s?800 Thandi Dlamini is behind on rent/ })).toHaveAttribute('href', '/reports');
    expect(await within(month).findByRole('link', { name: /Occupancy 2 of 3 1 unit vacant/ })).toHaveAttribute('href', '/properties');
    // Deposits held, summed from the leases.
    expect(within(month).getByText('Deposits held').parentElement).toHaveTextContent(/R\s?15\s?600.*across 2 leases/);
    expect(within(month).getByText(/^Collected in /).parentElement).toHaveTextContent(/R\s?7\s?800.*of R\s?31\s?200 invoiced/);
    const bar = await within(month).findByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '25');
    // Every task says what tapping it does.
    expect(screen.getByRole('link', { name: /Thandi Dlamini owes .* Follow up$/ })).toBeTruthy();
  });

  it('asks whose payment it is, then opens the payment form on that lease', async () => {
    quietHome();
    on('GET /leases', { items: [row(), row({ id: 'l2', ref: 'LSE-00002', unit: 'Oak 2', tenant: 'Kabelo Mokoena' })] });
    on('GET /leases/l2', baseLease({ id: 'l2', tenant: 'Kabelo Mokoena', unit: 'Oak 2' }));
    on('GET /leases/l2/arrears', { owing: null, case: null, next: null, letter: null, history: [] });
    mountHome();
    fireEvent.click(await screen.findByRole('button', { name: 'Record a payment' }));
    const chooser = await screen.findByRole('dialog');
    const choice = within(chooser).getByRole('link', { name: /Kabelo Mokoena/ });
    expect(choice).toHaveAttribute('href', '/leases/l2?pay=1');
    fireEvent.click(choice);
    const form = await screen.findByRole('dialog', { name: 'Record a payment' });
    expect((await within(form).findByLabelText('What this pays') as HTMLSelectElement).value).toBe('i-nov');
  });
});

describe('booking an inspection (bug 7)', () => {
  it('asks for the day of a move-out inspection, bounded to the last three days, and sends it', async () => {
    const lastDay = addDays(TODAY, 25);
    on('GET /leases/l1', baseLease({ termination: notice() }));
    on('POST /leases/l1/inspections', { id: 'n1', seeded: 10, replaced: null });
    mountLease();
    // Notice has been served, so a move-in inspection is refused and not offered.
    fireEvent.click(await screen.findByRole('button', { name: 'Book move-out' }));
    expect(screen.queryByRole('button', { name: 'Book move-in' })).toBeNull();
    const dialog = await screen.findByRole('dialog');
    const day = within(dialog).getByLabelText('Inspection day') as HTMLInputElement;
    expect(day.value).toBe(lastDay);
    expect(day.min).toBe(addDays(lastDay, -3));
    expect(day.max).toBe(lastDay);
    const book = within(dialog).getByRole('button', { name: 'Book the inspection' });
    fireEvent.change(day, { target: { value: addDays(lastDay, -5) } });
    expect(book).toBeDisabled();
    fireEvent.change(day, { target: { value: addDays(lastDay, -2) } });
    expect(book).toBeEnabled();
    expect(callsTo('POST /leases/l1/inspections')).toHaveLength(0);
    fireEvent.click(book);
    await screen.findByText('Move-out inspection created');
    expect(callsTo('POST /leases/l1/inspections')[0]!.body).toEqual({ kind: 'outgoing', scheduledFor: addDays(lastDay, -2) });
  });

  it('opens a move-in booking on the lease start when that is still ahead', async () => {
    on('GET /leases/l1', baseLease({ status: 'out_for_signature', startDate: addDays(TODAY, 12) }));
    on('POST /leases/l1/inspections', { id: 'n1', seeded: 10, replaced: null });
    mountLease();
    fireEvent.click(await screen.findByRole('button', { name: 'Book move-in' }));
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByLabelText('Inspection day') as HTMLInputElement).value).toBe(addDays(TODAY, 12));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Book the inspection' }));
    await waitFor(() => expect(callsTo('POST /leases/l1/inspections')).toHaveLength(1));
    expect(callsTo('POST /leases/l1/inspections')[0]!.body).toEqual({ kind: 'incoming', scheduledFor: addDays(TODAY, 12) });
  });

  it('offers no booking the server would refuse', async () => {
    // Past its end date with no notice: there is no last day to book against.
    on('GET /leases/l1', baseLease({
      endDate: addDays(TODAY, -10),
      inspections: [{ id: 'n0', kind: 'incoming', status: 'completed', scheduledFor: addDays(TODAY, -160), findings: 12, flagged: 0, reportKey: 'r.pdf' }],
    }));
    mountLease();
    expect(await screen.findByText(/Record a notice first/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Book move-out' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Book move-in' })).toBeNull();
    // Row actions say which inspection they open.
    expect(screen.getByRole('button', { name: /^Open the report for the move-in inspection of / })).toBeTruthy();
    expect(screen.getByRole('link', { name: /^Open the move-in inspection of / })).toHaveAttribute('href', '/inspections/n0');

    // An ended lease takes no inspection at all.
    on('GET /leases/l1', baseLease({ status: 'terminated', termination: notice({ status: 'settled', effectiveOn: addDays(TODAY, -5) }) }));
    mountLease();
    await screen.findByRole('link', { name: 'Deposit settlement' });
    expect(screen.queryByRole('button', { name: /^Book move-/ })).toBeNull();
  });
});

describe('recording a payment (bug 9)', () => {
  it('holds Save for a received date long before the lease, and says which days are allowed', async () => {
    on('GET /leases/l1', baseLease());
    on('POST /leases/l1/payments', {});
    mountLease();
    fireEvent.click(await screen.findByRole('button', { name: 'Record a payment' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Amount'), { target: { value: '7800' } });
    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect(save).toBeEnabled();
    // 2006 typed for 2026.
    fireEvent.change(within(dialog).getByLabelText('Received on'), { target: { value: `2006${TODAY.slice(4)}` } });
    expect(save).toBeDisabled();
    expect(within(dialog).getByRole('alert')).toHaveTextContent(`Pick a day from ${formatDate(addDays(addDays(TODAY, -165), -60))} to today`);
    // The earliest day allowed still saves.
    fireEvent.change(within(dialog).getByLabelText('Received on'), { target: { value: addDays(TODAY, -225) } });
    expect(save).toBeEnabled();
  });
});

describe('recording a notice (bug 10)', () => {
  it('refuses a landlord’s end-of-term notice more than 80 business days out, and says from when', async () => {
    const endDate = addDays(TODAY, 200);
    on('GET /leases/l1', baseLease({ endDate }));
    on('POST /leases/l1/termination', { effectiveOn: endDate });
    mountLease();
    fireEvent.click(await screen.findByRole('button', { name: 'Record a notice' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(`This notice can be recorded from ${formatDate(landlordEndOfTermServableFrom(endDate))}`)).toBeTruthy();
    fireEvent.click(within(dialog).getByLabelText('I understand this starts the end of the tenancy'));
    const record = within(dialog).getByRole('button', { name: 'Record it' });
    expect(record).toBeDisabled();
    // The rule is the landlord's end-of-term notice only: a tenant's written one goes through.
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'tenant_end_of_term' } });
    expect(within(dialog).queryByText(/This notice can be recorded from/)).toBeNull();
    expect(record).toBeEnabled();
  });

  it('takes the same notice inside the 80 business days', async () => {
    on('GET /leases/l1', baseLease({ endDate: addDays(TODAY, 90) }));
    mountLease();
    fireEvent.click(await screen.findByRole('button', { name: 'Record a notice' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText(/This notice can be recorded from/)).toBeNull();
    fireEvent.click(within(dialog).getByLabelText('I understand this starts the end of the tenancy'));
    expect(within(dialog).getByRole('button', { name: 'Record it' })).toBeEnabled();
  });
});

describe('the lease page', () => {
  it('offers a renewal only on a live lease, with the terms the landlord sets', async () => {
    on('GET /leases/l1', baseLease({ status: 'out_for_signature' }));
    mountLease();
    await screen.findByRole('button', { name: 'Record a payment' });
    expect(screen.queryByRole('button', { name: 'Offer a renewal' })).toBeNull();

    on('GET /leases/l1', baseLease());
    on('POST /leases/l1/renewal', { id: 'r1' });
    mountLease();
    fireEvent.click(await screen.findByRole('button', { name: 'Offer a renewal' }));
    const dialog = await screen.findByRole('dialog');
    // The escalation starts on the lease's own.
    expect((within(dialog).getByLabelText('Escalation percent a year') as HTMLInputElement).value).toBe('8');
    fireEvent.change(within(dialog).getByLabelText('New monthly rent'), { target: { value: '8500' } });
    fireEvent.change(within(dialog).getByLabelText('Term'), { target: { value: '24' } });
    fireEvent.change(within(dialog).getByLabelText('Escalation percent a year'), { target: { value: '6.5' } });
    fireEvent.change(within(dialog).getByLabelText('Days to answer'), { target: { value: '120' } });
    const send = within(dialog).getByRole('button', { name: 'Send the offer' });
    expect(send).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Days to answer'), { target: { value: '21' } });
    fireEvent.click(send);
    await screen.findByText('Renewal offered');
    expect(callsTo('POST /leases/l1/renewal')[0]!.body).toEqual({ newRentCents: 850000, termMonths: 24, escalationPct: 6.5, respondDays: 21 });
  });

  it('leaves the rent to the escalation when none is typed', async () => {
    on('GET /leases/l1', baseLease());
    on('POST /leases/l1/renewal', { id: 'r1' });
    mountLease();
    fireEvent.click(await screen.findByRole('button', { name: 'Offer a renewal' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Send the offer' }));
    await waitFor(() => expect(callsTo('POST /leases/l1/renewal')).toHaveLength(1));
    expect(callsTo('POST /leases/l1/renewal')[0]!.body).toEqual({ termMonths: 12, escalationPct: 8, respondDays: 14 });
  });

  it('tells the landlord once the tenant has confirmed their notice', async () => {
    on('GET /leases/l1', baseLease({ termination: notice({ awaitingTenant: true }) }));
    mountLease();
    expect(await screen.findByText(/Waiting for Thandi Dlamini to confirm it in the app/)).toBeTruthy();
    expect(screen.queryByText('Thandi Dlamini confirmed it.')).toBeNull();

    on('GET /leases/l1', baseLease({ termination: notice({ awaitingTenant: false }) }));
    mountLease();
    expect(await screen.findByText('Thandi Dlamini confirmed it.')).toBeTruthy();
  });

  it('marks the inspection views stale when a notice is withdrawn', async () => {
    on('GET /leases/l1', baseLease({ termination: notice({ initiatedBy: 'landlord', reason: 'end_of_term' }) }));
    on('POST /terminations/t1/withdraw', {});
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // The exit inspection's page, cached before the landlord came back here.
    client.setQueryData(['inspection', 'n1'], { id: 'n1' });
    render(
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <ToastProvider>
            <MemoryRouter initialEntries={['/leases/l1']}>
              <Routes><RouterRoute path="/leases/:leaseId" element={<LeaseDetail />} /></Routes>
            </MemoryRouter>
          </ToastProvider>
        </ThemeProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw the notice' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Withdraw the notice' }));
    await screen.findByText('Notice withdrawn');
    await waitFor(() => expect(client.getQueryState(['inspection', 'n1'])?.isInvalidated).toBe(true));
  });

  it('asks before removing a charge, and keeps it when the landlord backs out', async () => {
    const charge = { id: 'c1', period: TODAY.slice(0, 7), kind: 'utility', description: 'Water', amountCents: 25000, billed: true };
    on('GET /leases/l1', baseLease({ charges: [charge] }));
    on('DELETE /leases/l1/charges/c1', {});
    mountLease();
    fireEvent.click(await screen.findByRole('button', { name: /^Remove Water/ }));
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/the tenant owes that much less/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(callsTo('DELETE /leases/l1/charges/c1')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /^Remove Water/ }));
    dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove the charge' }));
    await screen.findByText('Charge removed');
    expect(callsTo('DELETE /leases/l1/charges/c1')).toHaveLength(1);
  });

  it('heads the page with the tenant and a status, and names each invoice’s PDF button', async () => {
    on('GET /leases/l1', baseLease({
      invoices: [{ id: 'i-oct', period: 'October 2026', dueOn: addDays(TODAY, -20), totalCents: 780000, paidCents: 300000, status: 'part_paid', pdfKey: 'x.pdf' }],
    }));
    mountLease();
    expect(await screen.findByRole('heading', { level: 1, name: 'Thandi Dlamini' })).toBeTruthy();
    expect(screen.getByText(/^Owes R\s?4\s?800/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open the October 2026 invoice PDF' })).toBeTruthy();
    const facts = screen.getByRole('region', { name: 'Key facts' });
    expect(within(facts).getByRole('link', { name: 't@example.co.za' })).toHaveAttribute('href', 'mailto:t@example.co.za');
  });
});

describe('settling the deposit (bug 11 and the unused API fields)', () => {
  const comparison = (deductions: unknown[] = []) => ({
    status: 'reconciling', statementKey: null, deductions,
    items: [{ room: 'Lounge', item: 'Door', incoming: { condition: 'good' }, outgoing: { condition: 'damaged' },
      findingId: 'f1', noBaseline: false, notReinspected: false, worsenedBy: 3, deductible: true }],
    summary: { unchanged: 0, wearAndTear: 0, deductible: 1, noBaseline: 0, notReinspected: 0 },
  });
  const figures = (overrides: Record<string, unknown> = {}) => ({
    heldCents: 820000, deductionsCents: 0, arrearsCents: 0, penaltyCents: 0, rentCreditCents: 0,
    refundCents: 820000, tenantOwesCents: 0, refundRule: 'no_deductions', blocker: null,
    effectiveOn: addDays(TODAY, -10), refundDueBy: addDays(TODAY, -3), ...overrides,
  });
  const mountSettlement = () => mount('/terminations/t1', <Route path="/terminations/:terminationId" element={<Termination />} />);

  it('holds the confirmation while the lease is still running', async () => {
    on('GET /terminations/t1/comparison', comparison());
    // An older server: no blocker for the date, only the end date itself.
    on('GET /terminations/t1/settlement', figures({ effectiveOn: addDays(TODAY, 9) }));
    mountSettlement();
    fireEvent.click(await screen.findByRole('button', { name: 'Settle the deposit' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Cannot settle yet')).toBeTruthy();
    expect(within(dialog).getByText(new RegExp(`The lease runs until ${formatDate(addDays(TODAY, 9))}`))).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Settle and end the lease' })).toBeDisabled();
    expect(callsTo('POST /terminations/t1/settle')).toHaveLength(0);
  });

  it('keeps the running figures beside the page, and sends the refund reference', async () => {
    on('GET /terminations/t1/comparison', comparison());
    on('GET /terminations/t1/settlement', figures());
    on('POST /terminations/t1/settle', {
      depositCents: 800000, interestCents: 20000, heldCents: 820000, deductionsCents: 0, arrearsCents: 0, penaltyCents: 0,
      rentCreditCents: 0, refundCents: 820000, tenantOwesCents: 0, refundRule: 'no_deductions', refundDueBy: addDays(TODAY, -3), statementKey: null,
    });
    mountSettlement();
    const side = await screen.findByRole('region', { name: 'Settlement so far' });
    expect(await within(side).findByText('Refund so far')).toBeTruthy();
    expect(within(side).getByText('Deposit and interest')).toBeTruthy();
    expect(within(side).getByText(formatDate(addDays(TODAY, -3)))).toBeTruthy();
    fireEvent.click(within(side).getByRole('button', { name: 'Settle the deposit' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(await within(dialog).findByLabelText('Refund reference'), { target: { value: '  DEP-REFUND-OAK1 ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Settle and end the lease' }));
    await screen.findByText('Deposit settled');
    expect(callsTo('POST /terminations/t1/settle')[0]!.body).toEqual({ refundReference: 'DEP-REFUND-OAK1' });
  });

  it('adds a deduction with no inspection finding behind it', async () => {
    let deductions: unknown[] = [];
    on('GET /terminations/t1/comparison', () => comparison(deductions));
    on('GET /terminations/t1/settlement', () => figures({ deductionsCents: deductions.length ? 65000 : 0 }));
    on('POST /terminations/t1/deductions', (body: any) => {
      deductions = [{ id: 'd1', description: body.description, amountCents: body.amountCents, findingId: null, evidenceKey: null }];
      return { id: 'd1' };
    });
    mountSettlement();
    fireEvent.click(await screen.findByRole('button', { name: 'Add another deduction' }));
    const dialog = await screen.findByRole('dialog');
    const add = within(dialog).getByRole('button', { name: 'Add the deduction' });
    expect(add).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('What it is for'), { target: { value: ' Carpet cleaning ' } });
    fireEvent.change(within(dialog).getByLabelText('Deduction amount'), { target: { value: '650' } });
    fireEvent.click(add);
    await screen.findByText('Deduction added');
    expect(callsTo('POST /terminations/t1/deductions')[0]!.body).toEqual({ description: 'Carpet cleaning', amountCents: 65000 });
    // It is listed, named on its Remove button, and the side figures are fetched again.
    expect(await screen.findByRole('button', { name: 'Remove the deduction for Carpet cleaning' })).toBeTruthy();
    await waitFor(() => expect(callsTo('GET /terminations/t1/settlement').length).toBeGreaterThan(1));
  });
});

describe('a tenant’s written notice (audit 6, journey break 1)', () => {
  const letter = () => new File(['%PDF-1.4 notice'], 'notice.pdf', { type: 'application/pdf' });

  it('lets the landlord upload it for a notice that awaits the tenant, and attests with a statement', async () => {
    let attested = false;
    on('GET /leases/l1', () => baseLease({
      termination: notice({
        awaitingTenant: !attested, attested,
        attestation: attested ? { at: '2026-11-10 09:00:00+00', statement: 'Thandi emailed me this notice.', evidenceKey: 'notices/t1.pdf' } : null,
      }),
    }));
    on('POST /leases/l1/notice-evidence/presign', { evidenceKey: 'notices/t1.pdf', uploadUrl: 'https://files.test/up', expiresInSeconds: 300 });
    on('POST /terminations/t1/attest', () => { attested = true; return { id: 't1', attested: true }; });
    mountLease();
    fireEvent.click(await screen.findByRole('button', { name: 'Tenant gave written notice: upload it' }));
    const dialog = await screen.findByRole('dialog');
    const attach = within(dialog).getByRole('button', { name: 'Attach and let the notice stand' });
    expect(attach).toBeDisabled();
    const file = letter();
    fireEvent.change(within(dialog).getByLabelText('Letter, email or photo of the notice'), { target: { files: [file] } });
    fireEvent.change(within(dialog).getByLabelText('How and when you received it'), { target: { value: 'Too short' } });
    expect(attach).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('How and when you received it'), { target: { value: ' Thandi emailed me this notice. ' } });
    fireEvent.click(attach);
    await screen.findByText('Written notice attached');
    // Presigned with the file's own size, sent as it is, then attested.
    expect(callsTo('POST /leases/l1/notice-evidence/presign')[0]!.body).toEqual({ contentType: 'application/pdf', sizeBytes: file.size });
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ url: 'https://files.test/up', contentType: 'application/pdf' });
    expect(puts[0]!.blob.size).toBe(file.size);
    expect(callsTo('POST /terminations/t1/attest')[0]!.body).toEqual({ evidenceKey: 'notices/t1.pdf', statement: 'Thandi emailed me this notice.' });
    // The card now shows what the notice stands on, and the upload is no longer offered.
    expect(await screen.findByText(/You attached the written notice on/)).toBeTruthy();
    expect(screen.getByText(/Thandi emailed me this notice/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open the written notice' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Tenant gave written notice: upload it' })).toBeNull();
  });

  it('shows the tenant the attestation and the file, and offers them no upload', async () => {
    as('tenant');
    on('GET /leases/l1', baseLease({
      viewer: { isLandlord: false, isTenant: true },
      termination: notice({ attested: true, attestation: { at: '2026-11-10 09:00:00+00', statement: 'Handed to me on 3 November.', evidenceKey: 'notices/t1.pdf' } }),
    }));
    mountLease();
    expect(await screen.findByText(/Your landlord attached the written notice on/)).toBeTruthy();
    expect(screen.getByText(/Handed to me on 3 November/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open the written notice' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Tenant gave written notice: upload it' })).toBeNull();
  });

  it('asks for the written notice when recording one for a tenant with no account, and sends it with the notice', async () => {
    on('GET /leases/l1', baseLease({ source: 'import', tenantHasAccount: false }));
    on('POST /leases/l1/notice-evidence/presign', { evidenceKey: 'notices/new.pdf', uploadUrl: 'https://files.test/up2', expiresInSeconds: 300 });
    on('POST /leases/l1/termination', { effectiveOn: addDays(TODAY, 30), attested: true });
    mountLease();
    fireEvent.click(await screen.findByRole('button', { name: 'Record a notice' }));
    const dialog = await screen.findByRole('dialog');
    // The landlord's own notice needs no letter from the tenant.
    expect(within(dialog).queryByLabelText('Letter, email or photo of the notice')).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'early_tenant' } });
    expect(within(dialog).getByText(/has no app account and cannot confirm this notice/)).toBeTruthy();
    fireEvent.click(within(dialog).getByLabelText('I understand this starts the end of the tenancy'));
    const record = within(dialog).getByRole('button', { name: 'Record it' });
    expect(record).toBeDisabled();
    const file = letter();
    fireEvent.change(within(dialog).getByLabelText('Letter, email or photo of the notice'), { target: { files: [file] } });
    fireEvent.change(within(dialog).getByLabelText('How and when you received it'), { target: { value: 'Posted through my door on Monday.' } });
    expect(record).toBeEnabled();
    fireEvent.click(record);
    await screen.findByText('Notice recorded');
    expect(callsTo('POST /leases/l1/notice-evidence/presign')[0]!.body).toEqual({ contentType: 'application/pdf', sizeBytes: file.size });
    expect(puts).toHaveLength(1);
    expect(callsTo('POST /leases/l1/termination')[0]!.body).toMatchObject({
      initiatedBy: 'tenant', reason: 'early_tenant', evidenceKey: 'notices/new.pdf', statement: 'Posted through my door on Monday.',
    });
  });

  it('refuses a file that is not a photo or a PDF', async () => {
    on('GET /leases/l1', baseLease({ termination: notice({ awaitingTenant: true }) }));
    mountLease();
    fireEvent.click(await screen.findByRole('button', { name: 'Tenant gave written notice: upload it' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Letter, email or photo of the notice'), {
      target: { files: [new File(['x'], 'notice.docx', { type: 'application/msword' })] },
    });
    fireEvent.change(within(dialog).getByLabelText('How and when you received it'), { target: { value: 'Emailed to me last week.' } });
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Use a photo (JPEG or PNG) or a PDF.');
    expect(within(dialog).getByRole('button', { name: 'Attach and let the notice stand' })).toBeDisabled();
  });
});

describe('payments on the lease page (audit 6, journey break 2)', () => {
  const payment = (overrides: Record<string, unknown> = {}) => ({
    id: 'p1', invoiceId: 'i-nov', amountCents: 780000, method: 'eft', reference: 'OAK1 NOV', receivedOn: addDays(TODAY, -2),
    reversedBy: null, reversesPaymentId: null, reason: null, ...overrides,
  });

  it('reverses a payment after asking for a reason, and shows it struck through with that reason', async () => {
    let payments: unknown[] = [payment(), payment({ id: 'p0', method: 'deposit', invoiceId: null, reference: null, amountCents: 100000 })];
    on('GET /leases/l1', baseLease());
    on('GET /leases/l1/statement', () => ({ payments }));
    on('POST /payments/p1/reverse', (body: any) => {
      payments = [
        payment({ reversedBy: 'p2' }),
        payment({ id: 'p2', method: 'reversal', amountCents: -780000, reversesPaymentId: 'p1', reason: body.reason, receivedOn: TODAY }),
      ];
      return { reversalId: 'p2', paymentId: 'p1' };
    });
    mountLease();
    const history = await screen.findByRole('region', { name: 'Payments' });
    // A settlement entry cannot be reversed, so only the payment has the action.
    const reverse = within(history).getAllByRole('button', { name: /^Reverse the payment of / });
    expect(reverse).toHaveLength(1);
    fireEvent.click(reverse[0]!);
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Reverse the payment' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Why it is being reversed'), { target: { value: ' Recorded on the wrong lease ' } });
    fireEvent.click(confirm);
    await screen.findByText('Payment reversed');
    expect(callsTo('POST /payments/p1/reverse')[0]!.body).toEqual({ reason: 'Recorded on the wrong lease' });
    // Reloaded: one row, struck through, with the reason; nothing left to reverse.
    const after = await screen.findByRole('region', { name: 'Payments' });
    expect(await within(after).findByText(/Reversed .*: Recorded on the wrong lease/)).toBeTruthy();
    expect(within(after).getByText('Reversed')).toBeTruthy();
    expect(within(after).getByText(/· November 2026$/).className).toContain('line-through');
    expect(within(after).queryByRole('button', { name: /^Reverse the payment of / })).toBeNull();
    expect(within(after).getAllByRole('listitem')).toHaveLength(1);
  });

  it('offers no reversal once the lease has ended, nor to the tenant', async () => {
    on('GET /leases/l1/statement', { payments: [payment()] });
    on('GET /leases/l1', baseLease({ status: 'terminated', termination: notice({ status: 'settled', effectiveOn: addDays(TODAY, -5) }) }));
    mountLease();
    const history = await screen.findByRole('region', { name: 'Payments' });
    expect(within(history).queryByRole('button', { name: /^Reverse/ })).toBeNull();

    as('tenant');
    on('GET /leases/l1', baseLease({ viewer: { isLandlord: false, isTenant: true } }));
    mountLease();
    await screen.findByRole('region', { name: 'Invoices' });
    expect(screen.queryByRole('region', { name: 'Payments' })).toBeNull();
  });
});

describe('the refund after settlement (audit 6, journey break 8)', () => {
  const settledComparison = {
    status: 'settled', statementKey: 'statements/t1.pdf', deductions: [], items: [],
    summary: { unchanged: 0, wearAndTear: 0, deductible: 0, noBaseline: 0, notReinspected: 0 },
  };
  const mountSettlement = () => mount('/terminations/t1', <Route path="/terminations/:terminationId" element={<Termination />} />);
  const ended = (refund: Record<string, unknown>) => baseLease({
    status: 'terminated',
    termination: notice({ status: 'settled', effectiveOn: addDays(TODAY, -12), refundDueBy: addDays(TODAY, 2), refundCents: 820000, refundPaidOn: null, refundReference: null, ...refund }),
  });

  it('records the day and reference the refund was paid, and then shows them', async () => {
    let paid: Record<string, unknown> = {};
    on('GET /terminations/t1/comparison', settledComparison);
    on('GET /leases', { items: [{ id: 'l1', terminationId: 't1' }, { id: 'l9', terminationId: null }] });
    on('GET /leases/l1', () => ended(paid));
    on('POST /terminations/t1/refund-paid', (body: any) => {
      paid = { refundPaidOn: body.paidOn, refundReference: body.reference };
      return { id: 't1', refundCents: 820000, refundDueBy: addDays(TODAY, 2), ...paid };
    });
    mountSettlement();
    const card = await screen.findByRole('region', { name: 'Refund to the tenant' });
    expect(within(card).getByText('Not paid yet')).toBeTruthy();
    expect(card).toHaveTextContent(/R\s?8\s?200/);
    // The list is asked for ended leases too: a settled lease is not on the default list.
    expect(callsTo('GET /leases')[0]!.body).toMatchObject({ query: { include: 'ended' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Mark refund paid' }));
    const dialog = await screen.findByRole('dialog');
    const day = within(dialog).getByLabelText('Paid on') as HTMLInputElement;
    expect(day.value).toBe(TODAY);
    expect(day.min).toBe(addDays(TODAY, -12));
    expect(day.max).toBe(TODAY);
    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled(); // no reference yet
    fireEvent.change(within(dialog).getByLabelText('Payment reference'), { target: { value: ' DEP OAK1 ' } });
    fireEvent.change(day, { target: { value: addDays(TODAY, -20) } });
    expect(save).toBeDisabled(); // before the lease ended
    fireEvent.change(day, { target: { value: addDays(TODAY, -1) } });
    fireEvent.click(save);
    await screen.findByText('Refund marked as paid');
    expect(callsTo('POST /terminations/t1/refund-paid')[0]!.body).toEqual({ paidOn: addDays(TODAY, -1), reference: 'DEP OAK1' });
    const after = screen.getByRole('region', { name: 'Refund to the tenant' });
    expect(within(after).getByText('Paid')).toBeTruthy();
    expect(within(after).getByText(formatDate(addDays(TODAY, -1)))).toBeTruthy();
    expect(within(after).getByText('DEP OAK1')).toBeTruthy();
    expect(within(after).queryByRole('button', { name: 'Mark refund paid' })).toBeNull();
  });

  it('asks for nothing when the tenant was owed no refund', async () => {
    on('GET /terminations/t1/comparison', settledComparison);
    on('GET /leases', { items: [{ id: 'l1', terminationId: 't1' }] });
    on('GET /leases/l1', ended({ refundCents: 0 }));
    mountSettlement();
    await screen.findByRole('button', { name: 'Open the deposit statement' });
    await waitFor(() => expect(callsTo('GET /leases/l1')).toHaveLength(1));
    expect(screen.queryByRole('button', { name: 'Mark refund paid' })).toBeNull();
  });
});
