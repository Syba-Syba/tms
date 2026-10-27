import { requireLeaseAccess } from '../lib/access';
import { query } from '../lib/db';
import { storage } from '../lib/storage';
import { badRequest, conflict, forbidden, json, notFound, route } from '../lib/http';
import { renderLeasePdf } from '../lib/pdf';
import { logger } from '../lib/logger';
import { notify } from '../lib/notify';
import { leaseParties } from '../lib/recipients';

/**
 * Renders the lease PDF whose SHA-256 the signing flow verifies.
 *
 * Only before anyone has signed. pdf-lib's output is not byte-for-byte reproducible, so a
 * re-render after a signature replaced the attested document with one the signatures' hashes
 * no longer match, and the lease stores one key, so the signed copy was gone for good.
 */
export const handler = route(async (event) => {
  const leaseId = event.pathParameters?.id;
  if (!leaseId) throw badRequest('A lease id is required.');
  // Membership of the landlord group used to be enough to render any lease at all.
  const access = await requireLeaseAccess(event, leaseId);
  if (!access.isLandlord) throw forbidden('Only the landlord renders the lease.');

  const [lease] = await query<{
    status: string;
    signatures: string;
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
    `select l.status,
            (select count(*) from lease_signature s where s.lease_id = l.id)::text as signatures,
            'LSE-' || lpad(l.ref_no::text, 5, '0') as ref,
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
  if (Number(lease.signatures) > 0) {
    throw conflict('This lease has been signed; its document cannot be re-rendered.');
  }
  if (['terminated', 'cancelled'].includes(lease.status)) {
    throw conflict(`This lease is ${lease.status}.`);
  }

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
  // The guard above is re-checked at write time: a signature that landed while rendering
  // must win, or it would attest a document this update is about to replace.
  const updated = await query<{ id: string }>(
    `update lease set pdf_s3_key = $2, pdf_sha256 = $3
      where id = $1 and not exists (select 1 from lease_signature s where s.lease_id = $1)
      returning id`,
    [leaseId, key, rendered.sha256],
  );
  if (updated.length === 0) {
    throw conflict('This lease has been signed; its document cannot be re-rendered.');
  }

  // Once per lease: the first document is the news. A re-render before anyone signs is a
  // correction, and the tenant sees the current one when they open it.
  try {
    const parties = await leaseParties(leaseId);
    if (parties?.tenant && lease.status === 'out_for_signature') {
      await notify({
        leaseId,
        to: parties.tenant,
        kind: 'lease_ready_to_sign',
        dedupeKey: `lease_ready_to_sign:${leaseId}`,
        data: { reference: parties.reference, unit: parties.unit, startDate: parties.startDate },
      });
    }
  } catch (error) {
    logger.error('Lease ready notification failed.', { leaseId, error });
  }

  return json(200, { key, sha256: rendered.sha256 });
});
