import { caller } from '../lib/auth';
import { query } from '../lib/db';
import { json, route } from '../lib/http';

/**
 * The applications a person has made, newest first, with where each stands. An applicant used
 * to land on "No active lease" after applying, with no sign the application had arrived and no
 * way back to it.
 */
export const handler = route(async (event) => {
  const person = caller(event);
  const rows = await query<{
    id: string; status: string; submitted_at: string | null; decided_at: string | null;
    unit_code: string; property_name: string; landlord: string; documents: number;
    lease_id: string | null; lease_status: string | null;
  }>(
    `select ap.id, ap.status, ap.submitted_at::text, ap.decided_at::text,
            u.code as unit_code, p.name as property_name, l.trading_name as landlord,
            (select count(*)::int from application_document d where d.application_id = ap.id) as documents,
            le.id as lease_id, le.status as lease_status
       from application ap
       join applicant a on a.id = ap.applicant_id
       join unit u on u.id = ap.unit_id
       join property p on p.id = u.property_id
       join landlord l on l.id = p.landlord_id
       left join lateral (
         select id, status from lease where application_id = ap.id and status <> 'cancelled'
          order by created_at desc limit 1
       ) le on true
      where a.cognito_sub = $1
      order by ap.created_at desc
      limit 20`,
    [person.sub],
  );
  return json(200, {
    items: rows.map((row) => ({
      id: row.id,
      status: row.status,
      submittedAt: row.submitted_at,
      decidedAt: row.decided_at,
      unit: `${row.property_name} ${row.unit_code}`,
      landlord: row.landlord,
      documents: row.documents,
      leaseId: row.lease_id,
      leaseStatus: row.lease_status,
    })),
  });
});
