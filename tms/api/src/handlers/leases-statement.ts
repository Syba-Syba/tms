import { requireLeaseAccess } from '../lib/access';
import { query } from '../lib/db';
import { badRequest, json, route } from '../lib/http';
import { ageBucket } from '../domain/money';
import { dateFromIso, sastToday } from '../domain/dates';
import { bankOf } from '../lib/landlord-account';

/** One statement per lease: invoices as debits, payments as credits, running balance,
    the deposit ledger alongside. Tenant and landlord see the identical document. */
export const handler = route(async (event) => {
  const leaseId = event.pathParameters?.id;
  if (!leaseId) throw badRequest('A lease id is required.');
  // A statement lists every payment on the lease, so it needs the same gate as the lease itself.
  await requireLeaseAccess(event, leaseId);

  // The reference a tenant puts on their EFT. The rent screen used to show a fixed one.
  const [lease] = await query<{
    ref: string; deposit_cents: string; status: string; previous_lease_id: string | null;
    landlord: string; landlord_phone: string; bank_changed_on: string | null; bank_name: string | null; bank_account_holder: string | null;
    bank_account_number: string | null; bank_branch_code: string | null;
  }>(
    `select 'LSE-' || lpad(l.ref_no::text, 5, '0') as ref, l.deposit_cents::text, l.status, l.previous_lease_id,
            ll.trading_name as landlord, ll.phone as landlord_phone,
            (select max(a.at)::date::text from audit_log a
              where a.entity = 'landlord' and a.entity_id = ll.id and a.action = 'landlord.bank_changed'
                and a.at > now() - interval '30 days') as bank_changed_on,
            ll.bank_name, ll.bank_account_holder, ll.bank_account_number, ll.bank_branch_code
       from lease l join unit u on u.id = l.unit_id join property p on p.id = u.property_id
       join landlord ll on ll.id = p.landlord_id
      where l.id = $1`,
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
    reverses_payment_id: string | null;
    reversal_reason: string | null;
    reversed_by: string | null;
  }>(
    `select p.id, p.invoice_id, p.amount_cents, p.method, p.reference, p.received_on::text,
            p.reverses_payment_id, p.reversal_reason,
            (select r.id from payment r where r.reverses_payment_id = p.id) as reversed_by
       from payment p where p.lease_id = $1 order by p.received_on, p.created_at`,
    [leaseId],
  );
  const deposit = await query<{ entry_type: string; amount_cents: string; occurred_on: string; note: string | null }>(
    `select entry_type, amount_cents, occurred_on::text, note
       from deposit_ledger where lease_id = $1 order by occurred_on`,
    [leaseId],
  );

  const proofs = await query<{
    id: string; target: string; invoice_id: string | null; amount_cents: string; paid_on: string;
    reference: string | null; status: string; reject_reason: string | null; submitted_at: string;
  }>(
    `select id, target, invoice_id, amount_cents, paid_on::text, reference, status, reject_reason,
            submitted_at::text
       from payment_proof where lease_id = $1 and status <> 'uploading'
      order by submitted_at desc limit 50`,
    [leaseId],
  );

  // Today in South Africa, as a date: the UTC instant still said yesterday until 02:00.
  const today = dateFromIso(sastToday());
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
    if (outstanding > 0) ageing[ageBucket(dateFromIso(invoice.due_on), today)]! += outstanding;
  }

  return json(200, {
    // The EFT reference the tenant pays with. Bank import matches on it.
    reference: lease?.ref ?? null,
    ref: lease?.ref ?? null,
    // Where to pay: the landlord's account, or null until they add one.
    landlord: lease?.landlord ?? null,
    bank: lease ? bankOf(lease) : null,
    // A recent change gets a warning on the tenant's screen: it is how rent gets stolen.
    bankChangedOn: lease?.bank_changed_on ?? null,
    landlordPhone: lease?.landlord_phone ?? null,
    balanceCents: invoiced - received,
    ageing,
    depositBalanceCents: depositBalance,
    // The deposit asked for less what is held, by the rule the lease list uses. The rent screen
    // said "fully paid up" while the home screen said the deposit was owed.
    depositOwingCents:
      lease && (lease.status === 'active' || (lease.status === 'scheduled' && !lease.previous_lease_id))
        ? Math.max(0, Number(lease.deposit_cents) - depositBalance)
        : 0,
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
      // A corrected payment stays on the record with the entry that undid it.
      reversedBy: payment.reversed_by,
      reversesPaymentId: payment.reverses_payment_id,
      reason: payment.reversal_reason,
    })),
    deposit,
    proofs: proofs.map((proof) => ({
      id: proof.id,
      target: proof.target,
      invoiceId: proof.invoice_id,
      amountCents: Number(proof.amount_cents),
      paidOn: proof.paid_on,
      reference: proof.reference,
      status: proof.status,
      rejectReason: proof.reject_reason,
      submittedAt: proof.submitted_at,
    })),
  });
});
