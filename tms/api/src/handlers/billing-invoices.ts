import { membershipOf } from '../lib/access';
import { requireLandlord } from '../lib/auth';
import { query } from '../lib/db';
import { badRequest, json, notFound, route } from '../lib/http';
import { renderBillingInvoicePdf } from '../lib/pdf';
import { storage } from '../lib/storage';
import { planById } from '../domain/plans';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

/**
 * The landlord's invoices from Threshold. GET lists them; POST /billing/invoices/{id}/render
 * makes the PDF once and keeps it, so the same invoice always opens as the same document.
 */
export const handler = route(async (event) => {
  const person = requireLandlord(event);
  const { landlordId } = await membershipOf(person);

  if (event.requestContext.http.method === 'GET') {
    const rows = await query<{ id: string; number: string; issued_on: string; period_from: string; period_to: string; plan: string; amount_cents: string; vat_cents: string; pdf_s3_key: string | null }>(
      `select id, number::text, issued_on::text, period_from::text, period_to::text, plan, amount_cents::text, vat_cents::text, pdf_s3_key
         from billing_invoice where landlord_id = $1 order by number desc limit 60`,
      [landlordId],
    );
    return json(200, {
      items: rows.map((row) => ({
        id: row.id, number: row.number, issuedOn: row.issued_on, periodFrom: row.period_from, periodTo: row.period_to,
        plan: row.plan, amountCents: Number(row.amount_cents), vatCents: Number(row.vat_cents), pdfKey: row.pdf_s3_key,
      })),
    });
  }

  const invoiceId = event.pathParameters?.id;
  if (!invoiceId) throw badRequest('Which invoice?');
  const [invoice] = await query<{
    number: string; issued_on: string; period_from: string; period_to: string; plan: string; amount_cents: string; vat_cents: string;
    supplier: Record<string, string | null>; recipient: Record<string, string | null>; pdf_s3_key: string | null;
  }>(
    `select number::text, issued_on::text, period_from::text, period_to::text, plan, amount_cents::text, vat_cents::text,
            supplier, recipient, pdf_s3_key
       from billing_invoice where id = $1 and landlord_id = $2`,
    [invoiceId, landlordId],
  );
  if (!invoice) throw notFound('Invoice');
  if (invoice.pdf_s3_key) return json(200, { key: invoice.pdf_s3_key });

  const supplier = invoice.supplier;
  const rendered = await renderBillingInvoicePdf({
    number: invoice.number,
    issuedOn: day(invoice.issued_on),
    supplier: {
      legalName: String(supplier.legalName ?? supplier.name ?? 'Threshold'),
      registrationNo: supplier.registrationNo ?? null,
      vatNo: supplier.vatNo ?? null,
      address: supplier.address ?? null,
      email: supplier.email ?? null,
      phone: supplier.phone ?? null,
    },
    recipient: {
      name: String(invoice.recipient.name ?? ''),
      email: invoice.recipient.email ?? null,
      registrationNo: invoice.recipient.registrationNo ?? null,
      vatNo: invoice.recipient.vatNo ?? null,
    },
    description: `${String(supplier.name ?? 'Threshold')} ${planById(invoice.plan)?.name ?? invoice.plan} plan, ${day(invoice.period_from)} to ${day(invoice.period_to)}`,
    amountCents: Number(invoice.amount_cents),
    vatCents: Number(invoice.vat_cents),
  });
  const key = `billing-invoices/${landlordId}/${invoice.number}.pdf`;
  await storage().put(key, rendered.bytes, 'application/pdf');
  await query('update billing_invoice set pdf_s3_key = $2 where id = $1', [invoiceId, key]);
  return json(200, { key });
});
