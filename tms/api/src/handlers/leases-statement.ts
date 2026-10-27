import { requireLeaseAccess } from '../lib/access';
import { query } from '../lib/db';
import { badRequest, json, route } from '../lib/http';
import { ageBucket } from '../domain/money';

/** One statement per lease: invoices as debits, payments as credits, running balance,
    the deposit ledger alongside. Tenant and landlord see the identical document. */
export const handler = route(async (event) => {
  const leaseId = event.pathParameters?.id;
  if (!leaseId) throw badRequest('A lease id is required.');
  // A statement lists every payment on the lease, so it needs the same gate as the lease itself.
  await requireLeaseAccess(event, leaseId);

  // The reference a tenant puts on their EFT. The rent screen used to show a fixed one.
  const [lease] = await query<{ ref: string }>(
    `select 'LSE-' || lpad(ref_no::text, 5, '0') as ref from lease where id = $1`,
    [leaseId],
  );

  const invoices = await query<{
    id: string;
    period_start: string;
    due_on: string;
    total_cents: string;
    status: string;
  }>(
    `select id, period_start::text, due_on::text, total_cents, status
       from invoice where lease_id = $1 and status <> 'void' order by period_start`,
    [leaseId],
  );
  const payments = await query<{
    id: string;
    invoice_id: string | null;
    amount_cents: string;
    method: string;
    reference: string | null;
    received_on: string;
  }>(
    `select id, invoice_id, amount_cents, method, reference, received_on::text
       from payment where lease_id = $1 order by received_on`,
    [leaseId],
  );
  const deposit = await query<{ entry_type: string; amount_cents: string; occurred_on: string; note: string | null }>(
    `select entry_type, amount_cents, occurred_on::text, note
       from deposit_ledger where lease_id = $1 order by occurred_on`,
    [leaseId],
  );

  const today = new Date();
  const invoiced = invoices.reduce((sum, invoice) => sum + Number(invoice.total_cents), 0);
  const received = payments.reduce((sum, payment) => sum + Number(payment.amount_cents), 0);
  const depositBalance = deposit.reduce(
    (sum, entry) =>
      sum + (['received', 'interest'].includes(entry.entry_type) ? 1 : -1) * Number(entry.amount_cents),
    0,
  );

  const ageing: Record<string, number> = { current: 0, d30: 0, d60: 0, d90: 0, d90plus: 0 };
  for (const invoice of invoices) {
    if (invoice.status === 'paid') continue;
    const paidOnInvoice = payments
      .filter((payment) => payment.invoice_id === invoice.id)
      .reduce((sum, payment) => sum + Number(payment.amount_cents), 0);
    const outstanding = Number(invoice.total_cents) - paidOnInvoice;
    if (outstanding > 0) ageing[ageBucket(new Date(invoice.due_on), today)]! += outstanding;
  }

  return json(200, {
    ref: lease?.ref ?? null,
    balanceCents: invoiced - received,
    ageing,
    depositBalanceCents: depositBalance,
    invoices: invoices.map((invoice) => ({
      id: invoice.id,
      period: invoice.period_start.slice(0, 7),
      dueOn: invoice.due_on,
      totalCents: Number(invoice.total_cents),
      status: invoice.status,
    })),
    payments: payments.map((payment) => ({
      id: payment.id,
      invoiceId: payment.invoice_id,
      amountCents: Number(payment.amount_cents),
      method: payment.method,
      reference: payment.reference,
      receivedOn: payment.received_on,
    })),
    deposit,
  });
});
