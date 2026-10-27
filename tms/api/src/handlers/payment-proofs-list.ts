import { landlordIdFor } from '../lib/access';
import { requireLandlord } from '../lib/auth';
import { query } from '../lib/db';
import { json, route } from '../lib/http';

/** The landlord's queue of slips to check. Scoped to their own properties, never the group. */
export const handler = route(async (event) => {
  const landlordId = await landlordIdFor(requireLandlord(event));
  const wanted = event.queryStringParameters?.status === 'all' ? null : 'pending';

  const rows = await query<{
    id: string; lease_id: string; lease_ref: string; tenant: string; unit: string; target: string;
    invoice_id: string | null; period: string | null; amount_cents: string; paid_on: string;
    reference: string | null; s3_key: string; content_type: string; status: string;
    submitted_at: string | null; reject_reason: string | null; owed_cents: string;
  }>(
    `select pp.id, pp.lease_id, 'LSE-' || lpad(l.ref_no::text, 5, '0') as lease_ref,
            a.first_name || ' ' || a.last_name as tenant, pr.name || ' ' || u.code as unit,
            pp.target, pp.invoice_id, to_char(i.period_start, 'YYYY-MM') as period,
            pp.amount_cents, pp.paid_on::text, pp.reference, pp.s3_key, pp.content_type, pp.status,
            pp.submitted_at::text, pp.reject_reason,
            (select coalesce(sum(oi.total_cents), 0) - coalesce((
               select sum(p.amount_cents) from payment p
                 join invoice pi on pi.id = p.invoice_id
                where pi.lease_id = l.id and pi.status in ('issued', 'part_paid')), 0)
               from invoice oi
              where oi.lease_id = l.id and oi.status in ('issued', 'part_paid'))::text as owed_cents
       from payment_proof pp
       join lease l on l.id = pp.lease_id
       join applicant a on a.id = l.applicant_id
       join unit u on u.id = l.unit_id
       join property pr on pr.id = u.property_id
       left join invoice i on i.id = pp.invoice_id
      where pr.landlord_id = $1
        and pp.status <> 'uploading'
        and ($2::text is null or pp.status = $2)
      order by pp.submitted_at desc nulls last
      limit 200`,
    [landlordId, wanted],
  );

  return json(200, {
    items: rows.map((row) => ({
      id: row.id,
      leaseId: row.lease_id,
      leaseRef: row.lease_ref,
      tenant: row.tenant,
      unit: row.unit,
      target: row.target,
      invoiceId: row.invoice_id,
      period: row.period,
      amountCents: Number(row.amount_cents),
      paidOn: row.paid_on,
      reference: row.reference,
      fileKey: row.s3_key,
      contentType: row.content_type,
      status: row.status,
      submittedAt: row.submitted_at,
      rejectReason: row.reject_reason,
      owedCents: Number(row.owed_cents),
    })),
  });
});
