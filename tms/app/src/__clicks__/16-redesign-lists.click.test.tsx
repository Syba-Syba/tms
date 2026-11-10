import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider, ToastProvider } from '@hlonie/toolbox/ui';
import { mount, Route } from './harness';
import { Listings } from '../screens/listings';
import { Properties } from '../screens/properties';
import { Payments } from '../screens/payments';
import { LandlordQueue } from '../screens/landlord-queue';
import { LeaseReview } from '../screens/lease-review';

/**
 * The redesigned list screens (properties, applications, payments, listings, lease signing) and
 * the audit 6 fixes that went in with them. Scripted API, as in 13 to 15: each call is recorded
 * with what it sent.
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

const on = (key: string, value: unknown) => mock.routes.set(key, value);
const callsTo = (key: string) => mock.calls.filter((call) => call.key === key);

beforeEach(() => {
  mock.routes.clear();
  mock.calls.length = 0;
  localStorage.setItem('tms.user', JSON.stringify({ sub: 'sub-landlord', role: 'landlord', name: 'landlord', email: 'landlord@example.co.za' }));
});

/** Like the harness mount, but with a client the test can inspect. */
const mountWith = (client: QueryClient, path: string, routes: React.ReactElement) => {
  cleanup();
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>{routes}</Routes>
          </MemoryRouter>
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
};

const listing = { description: null, availableFrom: null, furnished: false, petsAllowed: false, parkingBays: 0, listed: true, photos: [] };
const unit = (overrides: Record<string, unknown> = {}) => ({
  id: 'u1', code: 'A1', bedrooms: 2, bathrooms: 1, monthlyRentCents: 850000, depositCents: 850000, status: 'vacant',
  tenant: null, leaseId: null, leaseEnd: null, openApplications: 0, listing, ...overrides,
});
const property = (units: unknown[]) => ({
  id: 'p1', name: 'Oak Court', address: '1 Oak Road, Melville',
  fields: { name: 'Oak Court', addressLine1: '1 Oak Road', suburb: 'Melville', city: 'Johannesburg', province: 'Gauteng', postalCode: '2092' },
  units,
});
const landlord = {
  account: { id: 'll1', tradingName: 'Oak Rentals', email: 'o@example.co.za', phone: '0825550000', registrationNo: null, vatNo: null, slug: 'oak', bank: null },
  me: { role: 'owner' }, teamSize: 1, onboarding: { bank: true, property: true, unit: true, tenant: true, done: true },
};

describe('the public listings page with nothing listed (audit 6, bug 1)', () => {
  it('renders without contact details instead of crashing on a null phone', async () => {
    on('GET /listings', { landlord: { name: 'Oak Rentals', phone: null, email: null, slug: 'oak' }, items: [] });
    mount('/l/oak', <Route path="/l/:slug" element={<Listings />} />);
    expect(await screen.findByRole('heading', { name: 'Oak Rentals' })).toBeTruthy();
    expect(screen.getByText('Everything is let')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /^Call/ })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Email' })).toBeNull();
  });

  it('offers Call and Email when the landlord is advertising', async () => {
    on('GET /listings', {
      landlord: { name: 'Oak Rentals', phone: '082 555 0000', email: 'o@example.co.za', slug: 'oak' },
      items: [{
        id: 'u1', label: 'Oak Court A1', suburb: 'Melville', city: 'Johannesburg', bedrooms: 2, bathrooms: 1, monthlyRentCents: 850000,
        depositCents: 850000, description: null, availableFrom: null, furnished: false, petsAllowed: true, parkingBays: 0, photos: [],
      }],
    });
    mount('/l/oak', <Route path="/l/:slug" element={<Listings />} />);
    expect((await screen.findByRole('link', { name: 'Call 082 555 0000' })).getAttribute('href')).toBe('tel:0825550000');
    expect(screen.getByRole('link', { name: 'Email' }).getAttribute('href')).toBe('mailto:o@example.co.za');
    // No photo: a named placeholder, and the one Apply button.
    expect(screen.getByText('Photos on request')).toBeTruthy();
    expect(screen.getByText('Pets allowed')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: /^Apply for/ })).toHaveLength(1);
  });
});

describe('unit rows on Properties (audit 6, bug 12)', () => {
  beforeEach(() => {
    on('GET /landlord', landlord);
    on('GET /properties', {
      items: [property([
        unit({ id: 'u1', code: 'A1', status: 'vacant', openApplications: 2 }),
        unit({ id: 'u2', code: 'A2', status: 'held' }),
        unit({ id: 'u3', code: 'A3', status: 'occupied', tenant: 'Naledi Phiri', leaseId: 'l3', leaseEnd: '2027-04-24' }),
      ])],
    });
  });

  it('offers the apply link only for a vacant unit', async () => {
    mount('/properties', <Route path="/properties" element={<Properties />} />);
    expect(await screen.findByRole('button', { name: 'Copy the application link for A1' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Copy the application link for A2' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy the application link for A3' })).toBeNull();
    expect(screen.getByText('Held for an approved applicant')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Lease for A3' }).getAttribute('href')).toBe('/leases/l3');
    // The tenant is a person: a named avatar beside the name.
    expect(screen.getByRole('img', { name: 'Naledi Phiri' })).toBeTruthy();
    expect(screen.getAllByText('2 applications waiting').length).toBeGreaterThan(0);
  });

  it('sums the portfolio in tiles from the loaded units', async () => {
    mount('/properties', <Route path="/properties" element={<Properties />} />);
    expect(await screen.findByText('1 of 3')).toBeTruthy();
    expect(screen.getByText('Monthly rent roll')).toBeTruthy();
    expect(screen.getByText('from 1 let unit')).toBeTruthy();
  });

  it('refreshes the landlord account after a unit is saved, so the setup checklist keeps up', async () => {
    on('PUT /units/u1', {});
    mount('/properties', <Route path="/properties" element={<Properties />} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit A1' }));
    const before = callsTo('GET /landlord').length;
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await screen.findByText('Unit updated');
    await waitFor(() => expect(callsTo('GET /landlord').length).toBeGreaterThan(before));
  });

  it('holds the Remove button while a unit removal is in flight', async () => {
    let finish: () => void = () => {};
    on('DELETE /units/u1', () => new Promise((resolve) => { finish = () => resolve({}); }));
    mount('/properties', <Route path="/properties" element={<Properties />} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit A1' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove this unit' }));
    await screen.findByText(/no lease history and no applications/);
    const confirm = screen.getByRole('button', { name: 'Remove' });
    fireEvent.click(confirm);
    await waitFor(() => expect(confirm).toBeDisabled());
    fireEvent.click(confirm);
    finish();
    await screen.findByText('Unit removed');
    expect(callsTo('DELETE /units/u1')).toHaveLength(1);
  });

  it('holds the Remove button while a property removal is in flight', async () => {
    let finish: () => void = () => {};
    on('DELETE /properties/p1', () => new Promise((resolve) => { finish = () => resolve({}); }));
    mount('/properties', <Route path="/properties" element={<Properties />} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit property' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove this property' }));
    await screen.findByText(/only goes once it has no units/);
    const confirm = screen.getByRole('button', { name: 'Remove' });
    fireEvent.click(confirm);
    await waitFor(() => expect(confirm).toBeDisabled());
    fireEvent.click(confirm);
    finish();
    await screen.findByText('Property removed');
    expect(callsTo('DELETE /properties/p1')).toHaveLength(1);
  });
});

describe('a slip on Payments (audit 6, raw YYYY-MM)', () => {
  it('names the month in words and shows the tenant as a person', async () => {
    on('GET /payment-proofs', {
      items: [{
        id: 'p1', leaseId: 'l1', leaseRef: 'LSE-00001', tenant: 'Thandi Dlamini', unit: 'Oak Court A1', target: 'invoice', period: '2026-10',
        amountCents: 780000, paidOn: '2026-10-02', reference: 'LSE-00001', fileKey: 'k', owedCents: 780000,
      }],
    });
    on('GET /reports/arrears', {
      items: [{ leaseId: 'l1', tenant: 'Thandi Dlamini', unit: 'Oak Court A1', totalCents: 780000, ageing: { current: 0 } }],
      totals: { totalCents: 780000 },
    });
    on('GET /reports/income-expense', { totals: { invoicedCents: 1560000, collectedCents: 780000 } });
    mount('/payments', <Route path="/payments" element={<Payments />} />);
    expect(await screen.findByText('Rent for October 2026')).toBeTruthy();
    expect(screen.queryByText(/2026-10/)).toBeNull();
    expect(screen.getAllByRole('img', { name: 'Thandi Dlamini' }).length).toBeGreaterThan(0);
    // The two headline figures sit in tiles, and the tab says how many slips wait.
    expect(screen.getByText('Overdue from tenants')).toBeTruthy();
    expect(await screen.findByText('1 lease behind')).toBeTruthy();
    expect(screen.getByRole('tab', { name: /^Slips to check\s*1$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy();
  });

  it('opens the bank import from the empty slips state', async () => {
    on('GET /payment-proofs', { items: [] });
    on('GET /reports/arrears', { items: [], totals: { totalCents: 0 } });
    on('GET /reports/income-expense', { totals: { invoicedCents: 0, collectedCents: 0 } });
    on('GET /bank-imports', { items: [] });
    mount('/payments', <Route path="/payments" element={<Payments />} />);
    expect(await screen.findByText('No slips waiting')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Upload a bank statement' }));
    expect(await screen.findByLabelText('Statement file')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Bank import' }).getAttribute('aria-selected')).toBe('true');
  });
});

const application = (overrides: Record<string, unknown> = {}) => ({
  id: 'a1', status: 'approved', applicant: 'Sipho Mahlangu', unit: 'Oak Court A2', submittedAt: '2026-11-01 10:00:00+00',
  preferredMoveIn: '2026-12-01', occupants: 1, monthlyRentCents: 780000, monthlyIncomeCents: 3000000,
  affordability: { ratio: 0.26, band: 'comfortable' }, documentCount: 4, leaseId: null, leaseStatus: null, ...overrides,
});

describe('the Generate lease form (audit 6: labels and the deposit the app never sent)', () => {
  const openForm = async () => {
    on('GET /applications', { items: [application()] });
    on('GET /properties', { items: [] });
    on('POST /applications/a1/lease', { id: 'l9' });
    on('POST /leases/l9/render', {});
    mount('/applications', (
      <>
        <Route path="/applications" element={<LandlordQueue />} />
        <Route path="/lease/:leaseId" element={<div>PROBE-SIGNING</div>} />
      </>
    ));
    fireEvent.click(screen.getByRole('tab', { name: /^Approved/ }));
    const row = (await screen.findAllByText('Sipho Mahlangu')).find((node) => node.closest('tr'))!.closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Generate lease' }));
    return screen.findByRole('dialog');
  };

  it('names Start date, Term and Escalation for a screen reader', async () => {
    const dialog = await openForm();
    expect((within(dialog).getByLabelText('Start date') as HTMLInputElement).value).toBe('2026-12-01');
    expect((within(dialog).getByLabelText('Term') as HTMLSelectElement).value).toBe('12');
    expect((within(dialog).getByLabelText('Escalation % a year') as HTMLInputElement).value).toBe('8');
    expect(within(dialog).getByLabelText('Deposit')).toBeTruthy();
  });

  it('leaves the deposit to the unit when the field is empty', async () => {
    const dialog = await openForm();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Generate and open it' }));
    await screen.findByText('PROBE-SIGNING');
    expect(callsTo('POST /applications/a1/lease')[0]!.body).toEqual({ startDate: '2026-12-01', months: 12, escalationPct: 8 });
  });

  it('sends the agreed deposit and a term outside the usual four', async () => {
    const dialog = await openForm();
    fireEvent.change(within(dialog).getByLabelText('Term'), { target: { value: '9' } });
    const deposit = within(dialog).getByLabelText('Deposit');
    fireEvent.change(deposit, { target: { value: '12000' } });
    fireEvent.blur(deposit);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Generate and open it' }));
    await screen.findByText('PROBE-SIGNING');
    expect(callsTo('POST /applications/a1/lease')[0]!.body).toEqual({
      startDate: '2026-12-01', months: 9, escalationPct: 8, depositCents: 1200000,
    });
  });
});

describe('the applications queue', () => {
  it('counts each tab and says what the rent share means', async () => {
    on('GET /applications', { items: [application({ status: 'submitted', affordability: { ratio: 0.45, band: 'over' } })] });
    on('GET /properties', { items: [] });
    mount('/applications', <Route path="/applications" element={<LandlordQueue />} />);
    expect(await screen.findByRole('tab', { name: /^Waiting\s*1$/ })).toBeTruthy();
    expect((await screen.findAllByText('45% of income')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('High: more than the income carries easily').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('img', { name: 'Sipho Mahlangu' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Approve' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Decline' }).length).toBeGreaterThan(0);
  });

  it('teaches what will appear when nothing is waiting', async () => {
    on('GET /applications', { items: [] });
    on('GET /properties', { items: [] });
    mount('/applications', <Route path="/applications" element={<LandlordQueue />} />);
    expect(await screen.findByText('No applications waiting')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to Properties' }).getAttribute('href')).toBe('/properties');
  });
});

describe('signing a lease (audit 6: stale queue)', () => {
  it('refreshes the applications lists, so the queue stops saying "Continue signing"', async () => {
    on('GET /leases/l1', {
      id: 'l1', ref: 'LSE-00001', status: 'out_for_signature', unit: 'Oak Court A2', tenant: 'Sipho Mahlangu',
      startDate: '2026-12-01', endDate: '2027-11-30', monthlyRentCents: 780000, escalationPct: 8, depositCents: 780000,
      hasDocument: true, pdfKey: 'leases/l1.pdf', pdfSha256: 'a'.repeat(64), signatures: [],
      viewer: { isLandlord: true, isTenant: false },
    });
    on('POST /leases/l1/signature', {});
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['applications', 'approved'], { items: [] });
    client.setQueryData(['my-applications'], { items: [] });
    mountWith(client, '/lease/l1', <Route path="/lease/:leaseId" element={<LeaseReview />} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign as the landlord' }));
    await screen.findByText('Lease signed');
    await waitFor(() => {
      expect(client.getQueryState(['applications', 'approved'])?.isInvalidated).toBe(true);
      expect(client.getQueryState(['my-applications'])?.isInvalidated).toBe(true);
    });
    // The other party is a person, and the side column says where things stand.
    expect(screen.getByRole('img', { name: 'Sipho Mahlangu' })).toBeTruthy();
    expect(screen.getByText('What happens next')).toBeTruthy();
  });
});
