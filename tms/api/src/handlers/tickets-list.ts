import { caller } from '../lib/auth';
import { query } from '../lib/db';
import { badRequest, json, route } from '../lib/http';

export const handler = route(async (event) => {
  const person = caller(event);
  const isLandlord = person.groups.includes('landlord');
  const ACTIVE = ['open', 'assigned', 'quote_pending', 'quote_approved', 'in_progress', 'done'];
  const CLOSED = ['closed', 'cancelled'];
  const requested = event.queryStringParameters?.status ?? 'active';
  // Never interpolate a query parameter into SQL. Resolve it to a known list instead.
  const statuses =
    requested === 'active' ? ACTIVE
    : requested === 'closed' ? CLOSED
    : [...ACTIVE, ...CLOSED].includes(requested) ? [requested]
    : null;
  if (!statuses) throw badRequest('Unknown status filter.');

  const rows = await query<{
    id: string;
    title: string;
    category: string;
    severity: string;
    status: string;
    target_by: string;
    created_at: string;
    unit_code: string;
    contractor_name: string | null;
    quote_cents: string | null;
    rating: number | null;
  }>(
    `select t.id, t.title, t.category, t.severity, t.status,
            t.target_by::text, t.created_at::text, u.code as unit_code,
            c.name as contractor_name, t.quote_cents, t.rating
       from ticket t
       join lease l on l.id = t.lease_id
       join unit u on u.id = l.unit_id
       join property p on p.id = u.property_id
       join landlord ll on ll.id = p.landlord_id
       join applicant a on a.id = l.applicant_id
       -- Selected c.name without ever joining contractor, so every call was a 500.
       left join contractor c on c.id = t.contractor_id
      where t.status = any($3::text[])
        -- A landlord sees the tickets on their own properties, not every ticket in the
        -- system; group membership alone used to be the whole filter.
        -- Any member of the landlord's team, not only the owner: agents saw an empty list.
        and (($2 and exists (select 1 from landlord_member m where m.landlord_id = ll.id and m.sub = $1)) or a.cognito_sub = $1)
      order by t.target_by asc`,
    [person.sub, isLandlord, statuses],
  );

  const now = Date.now();
  return json(200, {
    items: rows.map((row) => ({
      id: row.id,
      title: row.title,
      category: row.category,
      severity: row.severity,
      status: row.status,
      unit: row.unit_code,
      contractor: row.contractor_name,
      quoteCents: row.quote_cents ? Number(row.quote_cents) : null,
      rating: row.rating,
      targetBy: row.target_by,
      // Overdue is a fact about the clock, computed on read, never stored and never stale.
      overdue: !['done', 'closed', 'cancelled'].includes(row.status) &&
        new Date(row.target_by).getTime() < now,
    })),
  });
});
