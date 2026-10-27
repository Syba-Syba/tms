import { query } from './db';
import type { Recipient } from './notify';

type Run = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

export interface LeaseParties {
  tenant: Recipient | null;
  tenantName: string;
  reference: string;
  unit: string;
  startDate: string;
}

/** The tenant on a lease, addressed for notify(), with the lease's reference and unit label. */
export async function leaseParties(leaseId: string, run: Run = query): Promise<LeaseParties | null> {
  const [row] = await run<{
    sub: string | null;
    email: string | null;
    phone: string | null;
    first_name: string;
    reference: string;
    unit: string;
    start_date: string;
  }>(
    `select a.cognito_sub as sub, a.email, a.phone, a.first_name,
            'LSE-' || lpad(l.ref_no::text, 5, '0') as reference,
            p.name || ' ' || u.code as unit, l.start_date::text as start_date
       from lease l
       join applicant a on a.id = l.applicant_id
       join unit u on u.id = l.unit_id
       join property p on p.id = u.property_id
      where l.id = $1`,
    [leaseId],
  );
  if (!row) return null;
  return {
    tenant: row.sub ? { sub: row.sub, email: row.email, phone: row.phone } : null,
    tenantName: row.first_name,
    reference: row.reference,
    unit: row.unit,
    startDate: row.start_date,
  };
}
