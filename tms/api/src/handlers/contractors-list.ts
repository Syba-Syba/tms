import { requireLandlord } from '../lib/auth';
import { query } from '../lib/db';
import { json, route } from '../lib/http';

/** The directory the assign form picks from, so a plumber's details are typed once ever. */
export const handler = route(async (event) => {
  const person = requireLandlord(event);
  const rows = await query<{
    id: string;
    name: string;
    trade: string;
    phone: string;
    email: string | null;
    jobs: string;
    last_used: string | null;
  }>(
    `select c.id, c.name, c.trade, c.phone, c.email,
            count(t.id) as jobs, max(t.created_at) as last_used
       from contractor c
       join landlord ll on ll.id = c.landlord_id
       left join ticket t on t.contractor_id = c.id
      where ll.id = (select landlord_id from landlord_member where sub = $1)
      group by c.id
      order by max(t.created_at) desc nulls last, c.name`,
    [person.sub],
  );

  return json(200, {
    items: rows.map((row) => ({
      id: row.id,
      name: row.name,
      trade: row.trade,
      phone: row.phone,
      email: row.email,
      jobs: Number(row.jobs),
      lastUsed: row.last_used,
    })),
  });
});
