import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route } from 'react-router';
import { mount } from './harness';
import { Termination } from '../screens/termination';
import { TenantRent } from '../screens/tenant-rent';
import { ApplyDocuments } from '../screens/apply-documents';
import { InspectionRoom } from '../screens/inspection-room';
import { TenantHome } from '../screens/tenant-home';
import { Payments } from '../screens/payments';

/**
 * Screen state that the live API cannot easily put a screen into (a deductible finding needs
 * two signed inspections; a returning applicant needs uploaded files), so these answer from a
 * scripted API instead. Everything else about the screen is real: the router, the query cache,
 * the toolbox components.
 */
const mock = vi.hoisted(() => ({
  routes: new Map<string, unknown>(),
  calls: [] as string[],
}));

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const respond = (method: string) => async (path: string, body?: unknown) => {
    mock.calls.push(`${method} ${path}`);
    const route = mock.routes.get(`${method} ${path}`);
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

vi.mock('../lib/photos', () => ({
  pickPhoto: async () => ({ dataUrl: 'data:image/jpeg;base64,AAAA', blob: new Blob(['x']), contentType: 'image/jpeg' }),
  putFile: async () => {},
}));

const on = (key: string, value: unknown) => mock.routes.set(key, value);
const callsTo = (key: string) => mock.calls.filter((call) => call === key).length;

beforeEach(() => {
  mock.routes.clear();
  mock.calls.length = 0;
});

describe('settling the deposit', () => {
  const comparison = (deductions: unknown[]) => ({
    status: 'open',
    statementKey: null,
    deductions,
    items: [
      {
        room: 'Lounge', item: 'Wall', incoming: { condition: 'good' }, outgoing: { condition: 'damaged' },
        findingId: 'f1', noBaseline: false, notReinspected: false, worsenedBy: 3, deductible: true,
      },
    ],
    summary: { unchanged: 0, wearAndTear: 0, deductible: 1, noBaseline: 0, notReinspected: 0 },
  });

  it('no longer offers Deduct for a finding already deducted, and shows the amount instead', async () => {
    on('GET /terminations/t1/comparison', comparison([
      { id: 'd1', description: 'Lounge · Wall', amountCents: 40000, findingId: 'f1', evidenceKey: null },
    ]));
    mount('/terminations/t1', <Route path="/terminations/:terminationId" element={<Termination />} />);
    await screen.findByText('Deductions recorded');
    expect(screen.queryByRole('button', { name: 'Deduct' })).toBeNull();
    expect(screen.getByText(/Deducted/)).toBeTruthy();
  });

  it('asks before settling, showing the exact refund, and settles only on confirmation', async () => {
    on('GET /terminations/t1/comparison', comparison([
      { id: 'd1', description: 'Lounge · Wall', amountCents: 40000, findingId: 'f1', evidenceKey: null },
    ]));
    on('GET /terminations/t1/settlement', {
      heldCents: 900000, deductionsCents: 40000, arrearsCents: 0, penaltyCents: 0, rentCreditCents: 0,
      refundCents: 860000, tenantOwesCents: 0, refundRule: 'with_deductions', refundDueBy: '2026-11-20', blocker: null,
    });
    on('POST /terminations/t1/settle', {
      depositCents: 900000, interestCents: 0, heldCents: 900000, deductionsCents: 40000, arrearsCents: 0,
      penaltyCents: 0, refundCents: 860000, tenantOwesCents: 0, refundRule: 'with_deductions',
      refundDueBy: '2026-11-20', statementKey: null,
    });
    mount('/terminations/t1', <Route path="/terminations/:terminationId" element={<Termination />} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Settle the deposit' }));
    const dialog = await screen.findByRole('dialog');
    expect(callsTo('POST /terminations/t1/settle')).toBe(0);
    expect(await within(dialog).findByText('Refund to the tenant')).toBeTruthy();
    expect(within(dialog).getByText('Less Lounge · Wall')).toBeTruthy();
    expect(within(dialog).getByText(/8\s?600/)).toBeTruthy();
    expect(within(dialog).getByText(/cannot be undone/i)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Settle and end the lease' }));
    await screen.findByText('Deposit settled');
    expect(callsTo('POST /terminations/t1/settle')).toBe(1);
  });
});

describe('the tenant’s rent page', () => {
  const statement = (proofs: unknown[]) => ({
    reference: 'REF1', landlord: 'L', bank: null, bankChangedOn: null, landlordPhone: null,
    balanceCents: 900000, depositBalanceCents: 0,
    invoices: [{ id: 'i1', period: '2026-10', dueOn: '2026-10-01', totalCents: 900000, status: 'issued' }],
    payments: [], proofs,
  });

  it('does not mark rent "Proof sent" for a waiting deposit slip', async () => {
    on('GET /leases/l1/statement', statement([
      { id: 'p1', target: 'deposit', invoiceId: null, amountCents: 900000, paidOn: '2026-10-01', reference: null, status: 'pending', rejectReason: null },
    ]));
    on('GET /leases/l1/arrears', null);
    mount('/rent/l1', <Route path="/rent/:leaseId" element={<TenantRent />} />);
    await screen.findByText('October 2026');
    expect(screen.queryByText('Proof sent')).toBeNull();
    expect(screen.getByText('Unpaid')).toBeTruthy();
  });

  it('refreshes the arrears panel after a slip is sent', async () => {
    on('GET /leases/l1/statement', statement([]));
    on('GET /leases/l1/arrears', null);
    on('POST /leases/l1/payment-proofs', { proofId: 'p9', uploadUrl: 'https://files.test/upload' });
    on('POST /payment-proofs/p9/submit', {});
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;
    try {
      mount('/rent/l1', <Route path="/rent/:leaseId" element={<TenantRent />} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Send proof of payment' }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.change(within(dialog).getByLabelText('Amount paid'), { target: { value: '9000' } });
      const file = new File(['slip'], 'slip.pdf', { type: 'application/pdf' });
      fireEvent.change(within(dialog).getByLabelText('Slip file'), { target: { files: [file] } });
      await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Send' })).toBeEnabled());
      const before = callsTo('GET /leases/l1/arrears');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Send' }));
      await screen.findByText('Proof sent');
      await waitFor(() => expect(callsTo('GET /leases/l1/arrears')).toBeGreaterThan(before));
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('an applicant coming back to their documents', () => {
  it('shows what is already on file and lets them finish', async () => {
    on('GET /applications/a1/documents', {
      items: ['id_copy', 'payslip', 'bank_statement', 'proof_of_address'].map((kind, index) => ({
        id: `doc${index}`, kind, contentType: 'image/jpeg', sizeBytes: 100, uploadedAt: '2026-10-01 10:00:00+00',
        viewUrl: `https://files.test/${kind}`,
      })),
    });
    on('GET /applications/a1/credit-check', { status: 'none' });
    mount('/apply/a1/documents', <Route path="/apply/:applicationId/documents" element={<ApplyDocuments />} />);
    await waitFor(() => expect(screen.getAllByText('Received')).toHaveLength(4));
    expect(screen.queryByText('Not uploaded yet')).toBeNull();
    expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Submit application' })).toBeNull();
  });
});

describe('an inspection photo', () => {
  it('appears once after it uploads and the inspection reloads, not twice', async () => {
    let photoKeys: string[] = [];
    on('GET /inspections/n1', () => ({
      id: 'n1', kind: 'incoming', status: 'in_progress', scheduledFor: '2026-10-01', leaseId: 'l1', unit: 'U1',
      reportKey: null, draftKey: null, draftSha256: null, viewer: { isLandlord: true, isTenant: false }, signatures: [],
      findings: [{ id: 'f1', room: 'Lounge', item: 'Wall', condition: 'poor', note: null, photoKeys }],
    }));
    on('POST /inspections/n1/photos/presign', { uploadUrl: 'https://files.test/up', photoId: 'ph1' });
    on('POST /photos/confirm', () => {
      photoKeys = ['inspections/ph1.jpg'];
      return {};
    });
    mount('/inspections/n1/room/Lounge', <Route path="/inspections/:inspectionId/room/:room" element={<InspectionRoom />} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add a photo' }));
    await screen.findByAltText('Wall photo');
    await waitFor(() => expect(screen.queryByAltText('Captured photo')).toBeNull());
    expect(screen.getAllByRole('img')).toHaveLength(1);
  });
});

describe('a tenant with no lease', () => {
  it('says the applications could not load rather than "No lease yet"', async () => {
    on('GET /leases', { items: [] });
    on('GET /me/applications', () => {
      throw Object.assign(new Error('down'), { status: 503 });
    });
    mount('/', <Route path="/" element={<TenantHome />} />);
    await screen.findByRole('button', { name: /try again|retry/i });
    expect(screen.queryByText('No lease yet')).toBeNull();
  });

  it('tells a former tenant their lease ended, and links a lease to sign', async () => {
    on('GET /leases', { items: [] });
    on('GET /me/applications', {
      items: [
        { id: 'a1', status: 'approved', submittedAt: '2025-10-06 23:30:00+00', unit: 'Old flat', landlord: 'L', documents: 4, leaseId: 'l0', leaseStatus: 'terminated' },
        { id: 'a2', status: 'approved', submittedAt: null, unit: 'New flat', landlord: 'L', documents: 4, leaseId: 'l2', leaseStatus: 'out_for_signature' },
      ],
    });
    mount('/', <Route path="/" element={<TenantHome />} />);
    await screen.findByText('Lease ended');
    // Sent at 01:30 on 7 Oct in Johannesburg, which is still 6 Oct in UTC.
    expect(screen.getByText(/sent 7 Oct 2025/)).toBeTruthy();
    expect(screen.queryByText(/preparing the lease/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Read and sign the lease' })).toHaveAttribute('href', '/lease/l2');
  });
});

describe('rejecting a slip', () => {
  it('names the reason field for a screen reader', async () => {
    on('GET /payment-proofs', {
      items: [{
        id: 'p1', leaseId: 'l1', leaseRef: 'LSE-1', tenant: 'T', unit: 'U', target: 'invoice', period: '2026-10',
        amountCents: 100, paidOn: '2026-10-01', reference: null, fileKey: 'k', owedCents: 100,
      }],
    });
    mount('/payments', <Route path="/payments" element={<Payments />} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    expect(await screen.findByRole('textbox', { name: 'Reason for rejecting' })).toBeTruthy();
  });
});
