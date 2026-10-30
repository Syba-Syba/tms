import { query } from './db';
import { storage } from './storage';
import { conflict, notFound } from './http';
import { renderLeasePdf } from './pdf';

/**
 * Renders a lease's PDF and stores its fingerprint, the one the signatures attest.
 *
 * Only before anyone has signed. pdf-lib's output is not byte-for-byte reproducible, so a
 * re-render after a signature replaced the attested document with one the signatures' hashes
 * no longer match, and the lease stores one key, so the signed copy was gone for good.
 *
 * Shared by the landlord's render route and by an accepted renewal, which renders its new
 * lease straight away so both parties can sign it before it starts.
 */
export async function renderLeaseDocument(
  leaseId: string,
): Promise<{ key: string; sha256: string; status: string }> {
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
    id_number_last4: string | null;
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

  // Each render gets its own key, and the lease points at it only through the guarded update
  // below. One fixed key was overwritten before that check ran, so a signature that landed
  // mid-render kept its hash while the document it attested was gone.
  const key = `leases/${leaseId}/lease-${rendered.sha256}.pdf`;
  await storage().put(key, rendered.bytes, 'application/pdf');
  // The guard above is re-checked at write time: a signature that landed while rendering
  // must win, or it would attest a document this update is about to replace.
  const updated = await query<{ id: string; old_key: string | null }>(
    `with before as (select pdf_s3_key from lease where id = $1)
     update lease set pdf_s3_key = $2, pdf_sha256 = $3
      where id = $1 and not exists (select 1 from lease_signature s where s.lease_id = $1)
      returning id, (select pdf_s3_key from before) as old_key`,
    [leaseId, key, rendered.sha256],
  );
  if (updated.length === 0) {
    // Nothing points at this render, so nothing (erasure included) would ever find it.
    await storage().remove(key).catch(() => undefined);
    throw conflict('This lease has been signed; its document cannot be re-rendered.');
  }
  // The superseded render carries the tenant's name and ID digits and no row points at it.
  const oldKey = updated[0]!.old_key;
  if (oldKey && oldKey !== key) await storage().remove(oldKey).catch(() => undefined);

  return { key, sha256: rendered.sha256, status: lease.status };
}
