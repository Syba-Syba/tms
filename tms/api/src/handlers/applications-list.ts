import { landlordIdFor } from '../lib/access';
import { requireLandlord } from '../lib/auth';
import { query } from '../lib/db';
import { badRequest, json, route } from '../lib/http';
import { affordability } from '../domain/application';

interface Row {
  id: string;
  status: string;
  submitted_at: string;
  preferred_move_in: string;
  occupants: number;
  first_name: string;
  last_name: string;
  monthly_income_cents: string;
  unit_code: string;
  property_name: string;
  monthly_rent_cents: string;
  document_count: string;
  lease_id: string | null;
  lease_status: string | null;
}

export const handler = route(async (event) => {
  const person = requireLandlord(event);
  // The queue carries applicant names, income and paperwork counts, so it is scoped to the
  // properties this landlord owns rather than to everyone in the landlord group.
  const landlordId = await landlordIdFor(person);
  const status = event.queryStringParameters?.status ?? 'submitted';
  const rawLimit = event.queryStringParameters?.limit;
  const limit = rawLimit ? Number(rawLimit) : 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw badRequest('limit must be 1 to 100.');

  const rows = await query<Row>(
    `select a.id, a.status, a.submitted_at, a.preferred_move_in, a.occupants,
            p.first_name, p.last_name,
            -- What was given with this application; the shared applicant row holds the latest.
            coalesce(a.monthly_income_cents, p.monthly_income_cents) as monthly_income_cents,
            u.code as unit_code, u.monthly_rent_cents, pr.name as property_name,
            (select count(*) from application_document d where d.application_id = a.id) as document_count,
            l.id as lease_id, l.status as lease_status
       from application a
       join applicant p on p.id = a.applicant_id
       join unit u on u.id = a.unit_id
       join property pr on pr.id = u.property_id
       -- One lease per application. A renewal copies the application id, so a plain join
       -- listed the tenant once per lease; the newest is the one to show.
       left join lateral (
         select le.id, le.status from lease le
          where le.application_id = a.id and le.status <> 'cancelled'
          order by le.start_date desc, le.created_at desc limit 1
       ) l on true
      where ($1 = 'all' or a.status = $1)
        and pr.landlord_id = $3
        -- Imported tenancies never went through the queue, so they stay out of it.
        and a.source = 'online'
      order by a.submitted_at desc nulls last
      limit $2`,
    [status, limit, landlordId],
  );

  return json(200, {
    items: rows.map((row) => {
      const income = Number(row.monthly_income_cents);
      const rent = Number(row.monthly_rent_cents);
      return {
        id: row.id,
        status: row.status,
        submittedAt: row.submitted_at,
        preferredMoveIn: row.preferred_move_in,
        occupants: row.occupants,
        applicant: `${row.first_name} ${row.last_name}`,
        unit: `${row.property_name} ${row.unit_code}`,
        monthlyRentCents: rent,
        monthlyIncomeCents: income,
        affordability: affordability(income, rent),
        documentCount: Number(row.document_count),
        leaseId: row.lease_id,
        leaseStatus: row.lease_status,
      };
    }),
  });
});
