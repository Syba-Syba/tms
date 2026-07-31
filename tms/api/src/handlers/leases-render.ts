import { requireLandlord } from '../lib/auth';
import { query } from '../lib/db';
import { storage } from '../lib/storage';
import { badRequest, json, notFound, route } from '../lib/http';
import { renderLeasePdf } from '../lib/pdf';

/** Closes the phase 1 gap: renders the lease PDF whose SHA-256 the signing flow verifies. */
export const handler = route(async (event) => {
  requireLandlord(event);
  const leaseId = event.pathParameters?.id;
  if (!leaseId) throw badRequest('A lease id is required.');

  const [lease] = await query<{
    ref: string;
    start_date: string;
    end_date: string;
    monthly_rent_cents: string;
    deposit_cents: string;
    escalation_pct: string;
    first_name: string;
    last_name: string;
    id_number_last4: string;
    unit_code: string;
    property_name: string;
    address: string;
    trading_name: string;
  }>(
    `select 'LSE-' || lpad(l.ref_no::text, 5, '0') as ref,
            l.start_date::text, l.end_date::text, l.monthly_rent_cents, l.deposit_cents, l.escalation_pct,
            a.first_name, a.last_name, a.id_number_last4,
            u.code as unit_code, p.name as property_name,
            p.address_line1 || ', ' || p.suburb || ', ' || p.city as address,
            ll.trading_name
       from lease l
       join applicant a on a.id = l.applicant_id
       join unit u on u.id = l.unit_id
       join property p on p.id = u.property_id
       join landlord ll on ll.id = p.landlord_id
      where l.id = $1`,
    [leaseId],
  );
  if (!lease) throw notFound('Lease');

  const rendered = await renderLeasePdf({
    ref: lease.ref,
    landlordName: lease.trading_name,
    tenantName: `${lease.first_name} ${lease.last_name}`,
    tenantIdLast4: lease.id_number_last4,
    unitLabel: `${lease.property_name} ${lease.unit_code}`,
    address: lease.address,
    startDate: lease.start_date,
    endDate: lease.end_date,
    rentCents: Number(lease.monthly_rent_cents),
    depositCents: Number(lease.deposit_cents),
    escalationPct: Number(lease.escalation_pct),
  });

  const key = `leases/${leaseId}/lease.pdf`;
  await storage().put(key, rendered.bytes, 'application/pdf');
  await query('update lease set pdf_s3_key = $2, pdf_sha256 = $3 where id = $1', [
    leaseId,
    key,
    rendered.sha256,
  ]);

  return json(200, { key, sha256: rendered.sha256 });
});
