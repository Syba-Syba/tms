import { landlordIdFor } from '../lib/access';
import { requireLandlord } from '../lib/auth';
import { query } from '../lib/db';
import { json, route } from '../lib/http';
import { erasureBlockFor } from '../lib/privacy';

/**
 * Erasure requests from people who applied to, or rented from, this landlord. Each says whether
 * the law still requires the records, so the landlord sees the answer before deciding.
 */
export const handler = route(async (event) => {
  const landlordId = await landlordIdFor(requireLandlord(event));
  const rows = await query<{
    id: string; person_sub: string; name: string; email: string; note: string | null; status: string;
    created_at: string; response: string | null;
  }>(
    `select r.id, r.person_sub, a.first_name || ' ' || a.last_name as name, a.email, r.note, r.status,
            r.created_at::text, r.response
       from privacy_request r
       join applicant a on a.cognito_sub = r.person_sub
      -- This landlord's own requests. Ones from before requests were per landlord have none,
      -- and show to every landlord the person applied to, as they always did.
      where r.landlord_id = $1
         or (r.landlord_id is null and exists (
              select 1 from application ap join unit u on u.id = ap.unit_id join property p on p.id = u.property_id
               where ap.applicant_id = a.id and p.landlord_id = $1))
      order by (r.status = 'pending') desc, r.created_at desc
      limit 100`,
    [landlordId],
  );
  const items = [];
  for (const row of rows) {
    items.push({
      id: row.id,
      name: row.name,
      email: row.email,
      note: row.note,
      status: row.status,
      createdAt: row.created_at,
      response: row.response,
      blockedBecause: row.status === 'pending' ? await erasureBlockFor(row.person_sub, landlordId) : null,
    });
  }
  return json(200, { items });
});
