import { query } from './db';

export interface LeaseParties {
  leaseId: string;
  ref: string;
  startDate: string;
  unit: string;
  premises: string;
  tenantSub: string;
  tenantName: string;
  tenantEmail: string;
  tenantPhone: string;
  landlordSub: string | null;
  landlordName: string;
  landlordEmail: string;
  landlordPhone: string;
}

/**
 * Who is on a lease and how to reach them. A tenant added without an account has no sign-in,
 * so messages to them are keyed on their applicant row instead: email still reaches them.
 */
export async function leaseParties(leaseId: string): Promise<LeaseParties | null> {
  const [row] = await query<{
    ref: string; start_date: string; unit: string; premises: string; tenant_sub: string; tenant_name: string;
    tenant_email: string; tenant_phone: string; landlord_sub: string | null; landlord_name: string;
    landlord_email: string; landlord_phone: string;
  }>(
    `select 'LSE-' || lpad(l.ref_no::text, 5, '0') as ref, l.start_date::text,
            p.name || ' ' || u.code as unit,
            u.code || ', ' || p.name || ', ' || p.address_line1 || ', ' || p.suburb || ', ' || p.city || ', ' || p.postal_code as premises,
            coalesce(a.cognito_sub, 'applicant:' || a.id) as tenant_sub,
            a.first_name || ' ' || a.last_name as tenant_name, a.email as tenant_email, a.phone as tenant_phone,
            ll.cognito_sub as landlord_sub, ll.trading_name as landlord_name, ll.email as landlord_email,
            ll.phone as landlord_phone
       from lease l
       join applicant a on a.id = l.applicant_id
       join unit u on u.id = l.unit_id
       join property p on p.id = u.property_id
       join landlord ll on ll.id = p.landlord_id
      where l.id = $1`,
    [leaseId],
  );
  if (!row) return null;
  return {
    leaseId,
    ref: row.ref,
    startDate: row.start_date,
    unit: row.unit,
    premises: row.premises,
    tenantSub: row.tenant_sub,
    tenantName: row.tenant_name,
    tenantEmail: row.tenant_email,
    tenantPhone: row.tenant_phone,
    landlordSub: row.landlord_sub,
    landlordName: row.landlord_name,
    landlordEmail: row.landlord_email,
    landlordPhone: row.landlord_phone,
  };
}
