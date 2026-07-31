import { caller } from '../lib/auth';
import { query } from '../lib/db';
import { json, route } from '../lib/http';

/** What a prospective tenant can apply for. Vacant only: a held unit has someone ahead of them. */
export const handler = route(async (event) => {
  caller(event);
  const rows = await query<{
    id: string;
    code: string;
    bedrooms: number;
    bathrooms: number;
    monthly_rent_cents: string;
    deposit_cents: string;
    property_name: string;
    suburb: string;
    city: string;
  }>(
    `select u.id, u.code, u.bedrooms, u.bathrooms, u.monthly_rent_cents, u.deposit_cents,
            p.name as property_name, p.suburb, p.city
       from unit u
       join property p on p.id = u.property_id
      where u.status = 'vacant'
      order by p.name, u.code`,
  );

  return json(200, {
    items: rows.map((row) => ({
      id: row.id,
      label: `${row.property_name} ${row.code}`,
      suburb: row.suburb,
      city: row.city,
      bedrooms: row.bedrooms,
      bathrooms: row.bathrooms,
      monthlyRentCents: Number(row.monthly_rent_cents),
      depositCents: Number(row.deposit_cents),
    })),
  });
});
