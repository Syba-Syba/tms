import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { mount, Route } from './harness';
import { Reports } from '../screens/reports';
import { Documents } from '../screens/documents';
import { Activity } from '../screens/activity';
import { LandlordOnly } from '../routes';

/**
 * The redesign of the records screens (reports, documents, activity, settings) changed a few
 * behaviours on purpose. Like 13 to 15, these answer from a scripted API and record each call.
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
const as = (role: 'landlord' | 'tenant') =>
  localStorage.setItem('tms.user', JSON.stringify({ sub: `sub-${role}`, role, name: role, email: `${role}@example.co.za` }));

beforeEach(() => {
  mock.routes.clear();
  mock.calls.length = 0;
  as('landlord');
});

const reportsQuiet = () => {
  on('GET /properties', { items: [] });
  on('GET /reports/income-expense', {
    from: '2026-03-01', to: '2027-02-28', items: [],
    totals: { property: 'Total', invoicedCents: 0, collectedCents: 0, expenseCents: {}, expensesCents: 0, netCents: 0 },
  });
  on('GET /reports/arrears', { asOf: '2026-11-10', items: [], totals: { totalCents: 0, ageing: {} } });
};
const openExpenses = async () => {
  mount('/reports', <Route path="/reports" element={<Reports />} />);
  fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Expenses' }));
};

describe('an expense whose slip upload fails (audit 6, bug 13)', () => {
  it('keeps the form open and uploads the slip on a retry, without a second expense', async () => {
    reportsQuiet();
    on('GET /expenses', { items: [] });
    on('POST /expenses', { id: 'e1', uploadUrl: 'https://files.test/up' });
    on('POST /expenses/e1/slip/confirm', {});
    const realFetch = globalThis.fetch;
    let uploads = 0;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).startsWith('https://files.test/')) {
        uploads += 1;
        // The first attempt drops; the second goes through.
        if (uploads === 1) throw new TypeError('Failed to fetch');
        return new Response('', { status: 200 });
      }
      return realFetch(url, init);
    }) as typeof fetch;
    try {
      await openExpenses();
      fireEvent.click(await screen.findByRole('button', { name: 'Add expense' }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.change(within(dialog).getByLabelText('Description'), { target: { value: 'Geyser repair' } });
      fireEvent.change(within(dialog).getByLabelText('Amount'), { target: { value: '3000' } });
      fireEvent.change(within(dialog).getByLabelText('Slip file'), {
        target: { files: [new File(['slip'], 'slip.pdf', { type: 'application/pdf' })] },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

      // Still open, and it says what happened where the person is looking.
      const warning = await within(dialog).findByRole('alert');
      expect(warning.textContent).toContain('The expense is saved, but the slip did not upload');
      expect(callsTo('POST /expenses/e1/slip/confirm')).toHaveLength(0);

      fireEvent.click(within(dialog).getByRole('button', { name: 'Try the slip again' }));
      await screen.findByText('Slip uploaded');
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(uploads).toBe(2);
      expect(callsTo('POST /expenses')).toHaveLength(1);
      expect(callsTo('POST /expenses/e1/slip/confirm')).toHaveLength(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('lets the landlord finish without the slip', async () => {
    reportsQuiet();
    on('GET /expenses', { items: [] });
    on('POST /expenses', { id: 'e1', uploadUrl: 'https://files.test/up' });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).startsWith('https://files.test/')) return new Response('', { status: 500 });
      return realFetch(url, init);
    }) as typeof fetch;
    try {
      await openExpenses();
      fireEvent.click(await screen.findByRole('button', { name: 'Add expense' }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.change(within(dialog).getByLabelText('Description'), { target: { value: 'Geyser repair' } });
      fireEvent.change(within(dialog).getByLabelText('Amount'), { target: { value: '3000' } });
      fireEvent.change(within(dialog).getByLabelText('Slip file'), {
        target: { files: [new File(['slip'], 'slip.pdf', { type: 'application/pdf' })] },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      fireEvent.click(await within(dialog).findByRole('button', { name: 'Finish without the slip' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(callsTo('POST /expenses')).toHaveLength(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('deleting an expense', () => {
  it('asks in a dialog first, and deletes only on confirm', async () => {
    reportsQuiet();
    on('GET /expenses', {
      items: [{
        id: 'e1', propertyId: null, property: null, unitId: null, unit: null, category: 'repairs',
        description: 'Geyser repair', amountCents: 300000, incurredOn: '2026-10-02', slipKey: null,
      }],
    });
    on('DELETE /expenses/e1', { deleted: true });
    await openExpenses();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Geyser repair' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete this expense?')).toBeTruthy();
    expect(callsTo('DELETE /expenses/e1')).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await screen.findByText('Expense deleted');
    expect(callsTo('DELETE /expenses/e1')).toHaveLength(1);
  });
});

describe('the reports screen', () => {
  it('shows the headline figures in tiles above the statement', async () => {
    on('GET /properties', { items: [] });
    on('GET /reports/arrears', { asOf: '2026-11-10', items: [], totals: { totalCents: 0, ageing: {} } });
    const row = { propertyId: 'p1', property: 'Melville Gardens', invoicedCents: 2580000, collectedCents: 1800000, expenseCents: { repairs: 2000000 }, expensesCents: 2000000, netCents: -200000 };
    on('GET /reports/income-expense', { from: '2026-03-01', to: '2027-02-28', items: [row], totals: { ...row, propertyId: null, property: 'Total' } });
    mount('/reports', <Route path="/reports" element={<Reports />} />);
    expect(await screen.findByText('Rent invoiced', { selector: 'p' })).toBeTruthy();
    expect(screen.getByText('Costs were more than rent collected')).toBeTruthy();
    expect(screen.getByText('Melville Gardens')).toBeTruthy();
    expect(screen.getByLabelText('Period')).toBeTruthy();
  });
});

describe('role routing (audit 6, low)', () => {
  const guarded = (
    <>
      <Route path="/" element={<p>HOME-PROBE</p>} />
      <Route element={<LandlordOnly />}>
        <Route path="/settings/account" element={<p>ACCOUNT-PROBE</p>} />
        <Route path="/reports" element={<p>REPORTS-PROBE</p>} />
      </Route>
    </>
  );

  it('sends a tenant who opens a landlord page to their home', async () => {
    as('tenant');
    mount('/settings/account', guarded);
    expect(await screen.findByText('HOME-PROBE')).toBeTruthy();
    expect(screen.queryByText('ACCOUNT-PROBE')).toBeNull();
    mount('/reports', guarded);
    expect(await screen.findByText('HOME-PROBE')).toBeTruthy();
  });

  it('lets a landlord through', async () => {
    mount('/settings/account', guarded);
    expect(await screen.findByText('ACCOUNT-PROBE')).toBeTruthy();
  });
});

const lease = (overrides: Record<string, unknown> = {}) => ({
  id: 'l1', ref: 'LSE-00001', unit: 'Oak 1', startDate: '2026-01-01', endDate: '2026-12-31', hasDocument: true,
  status: 'active', source: 'online', signatures: [], pdfKey: 'leases/l1.pdf', inspections: [], invoices: [],
  termination: null, ...overrides,
});

describe('the documents screen', () => {
  it('asks a landlord which lease, instead of showing whichever is newest', async () => {
    on('GET /leases', {
      items: [
        { id: 'l2', ref: 'LSE-00002', status: 'active', unit: 'Oak 2', tenant: 'Sipho Mahlangu' },
        { id: 'l1', ref: 'LSE-00001', status: 'active', unit: 'Oak 1', tenant: 'Thandi Dlamini' },
      ],
    });
    on('GET /leases/l1', lease());
    mount('/documents', <Route path="/documents" element={<Documents />} />);
    expect(await screen.findByText('Choose a lease')).toBeTruthy();
    expect(screen.getByText('Thandi Dlamini')).toBeTruthy();
    expect(mock.calls.some((call) => call.key.startsWith('GET /leases/'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Show documents for LSE-00001' }));
    expect(await screen.findByRole('button', { name: 'Open the lease' })).toBeTruthy();
    expect(callsTo('GET /leases/l1')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'All leases' }));
    expect(await screen.findByText('Choose a lease')).toBeTruthy();
  });

  it('does not promise every invoice when only the latest twelve are sent', async () => {
    as('tenant');
    on('GET /leases', { items: [{ id: 'l1', ref: 'LSE-00001', status: 'active' }] });
    on('GET /leases/l1', lease({
      invoices: Array.from({ length: 12 }, (_, index) => ({
        id: `i${index}`, period: `Month ${index + 1}`, dueOn: '2026-10-01', totalCents: 780000, status: 'paid', pdfKey: null,
      })),
    }));
    mount('/documents', <Route path="/documents" element={<Documents />} />);
    expect(await screen.findByText('The latest 12 are listed.')).toBeTruthy();
    expect(screen.queryByText(/every invoice/i)).toBeNull();
    // Each button says which invoice it is for.
    expect(screen.getByRole('button', { name: 'PDF of the invoice for Month 3' })).toBeTruthy();
  });
});

describe('the activity screen', () => {
  it('groups entries by day, names who did it, and opens the lease from a button', async () => {
    on('GET /audit', {
      nextBefore: null,
      items: [
        { id: 2, at: '2026-10-07 10:00:00+00', action: 'payment.recorded', entity: 'payment', entityId: 'p1', leaseId: 'l1', actor: { role: 'landlord', name: 'Mokoena Properties' } },
        { id: 1, at: '2026-10-06 09:00:00+00', action: 'auth.login', entity: 'credential', entityId: null, leaseId: null, actor: { role: 'tenant', name: 'Thandi Dlamini' } },
      ],
    });
    mount('/activity', (
      <>
        <Route path="/activity" element={<Activity />} />
        <Route path="/leases/:leaseId" element={<p>LEASE-PROBE</p>} />
      </>
    ));
    const day = await screen.findByRole('region', { name: '7 Oct 2026' });
    expect(within(day).getByText('Payment recorded')).toBeTruthy();
    expect(within(day).getByText('by Mokoena Properties')).toBeTruthy();
    expect(within(day).getByRole('img', { name: 'Mokoena Properties' })).toBeTruthy();
    expect(screen.getByRole('region', { name: '6 Oct 2026' })).toBeTruthy();
    fireEvent.click(within(day).getByRole('button', { name: 'Open the lease' }));
    expect(await screen.findByText('LEASE-PROBE')).toBeTruthy();
  });
});
