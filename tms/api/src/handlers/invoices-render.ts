import { requireLeaseAccessVia } from '../lib/access';
import { query } from '../lib/db';
import { storage } from '../lib/storage';
import { badRequest, json, notFound, route } from '../lib/http';
import { renderInvoicePdf } from '../lib/pdf';
import { bankOf } from '../lib/landlord-account';

export const handler = route(async (event) => {
  const invoiceId = event.pathParameters?.id;
  if (!invoiceId) throw badRequest('An invoice id is required.');
  await requireLeaseAccessVia(
    event,
    'select lease_id from invoice where id = $1',
    [invoiceId],
    'Invoice',
  );

  const [invoice] = await query<{
    id: string;
    period_start: string;
    due_on: string;
    total_cents: string;
    tenant: string;
    unit_label: string;
    lease_ref: string;
    invoice_ref: string;
    trading_name: string;
    bank_name: string | null; bank_account_holder: string | null; bank_account_number: string | null; bank_branch_code: string | null;
  }>(
    `select i.id, i.period_start::text, i.due_on::text, i.total_cents,
            a.first_name || ' ' || a.last_name as tenant,
            p.name || ' ' || u.code as unit_label,
            'LSE-' || lpad(l.ref_no::text, 5, '0') as lease_ref,
            'INV-' || lpad(i.ref_no::text, 5, '0') as invoice_ref,
            ll.trading_name, ll.bank_name, ll.bank_account_holder, ll.bank_account_number, ll.bank_branch_code
       from invoice i
       join lease l on l.id = i.lease_id
       join applicant a on a.id = l.applicant_id
       join unit u on u.id = l.unit_id
       join property p on p.id = u.property_id
       join landlord ll on ll.id = p.landlord_id
      where i.id = $1`,
    [invoiceId],
  );
  if (!invoice) throw notFound('Invoice');

  const lines = await query<{ description: string; amount_cents: string }>(
    'select description, amount_cents from invoice_line where invoice_id = $1',
    [invoiceId],
  );

  const rendered = await renderInvoicePdf({
    ref: invoice.invoice_ref,
    landlordName: invoice.trading_name,
    tenantName: invoice.tenant,
    unitLabel: invoice.unit_label,
    period: invoice.period_start.slice(0, 7),
    dueOn: invoice.due_on,
    lines: lines.map((line) => ({ description: line.description, amountCents: Number(line.amount_cents) })),
    totalCents: Number(invoice.total_cents),
    paymentReference: invoice.lease_ref,
    bank: bankOf(invoice),
  });

  const key = `invoices/${invoiceId}/invoice.pdf`;
  await storage().put(key, rendered.bytes, 'application/pdf');
  await query('update invoice set pdf_s3_key = $2 where id = $1', [invoiceId, key]);
  return json(200, { key });
});
