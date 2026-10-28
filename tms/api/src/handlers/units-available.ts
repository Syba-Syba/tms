import { caller } from '../lib/auth';
import { query } from '../lib/db';
import { json, notFound, route } from '../lib/http';

/**
 * What a prospective tenant can apply for. Vacant only: a held unit has someone ahead of them.
 *
 * Each landlord shares their own link, /apply?landlord=their-slug, and it lists only their
 * units. Without one, an installation with a single landlord lists everything as it always has;
 * with several, it lists nothing, so no landlord's tenants are shown another landlord's units.
 */
export const handler = route(async (event) => {
  caller(event);
  const slug = event.queryStringParameters?.landlord?.trim().toLowerCase() || null;
  let landlord: { id: string; trading_name: string } | null = null;
  if (slug) {
    [landlord = null] = await query<{ id: string; trading_name: string }>(
      'select id, trading_name from landlord where slug = $1',
      [slug],
    );
    if (!landlord) throw notFound('Landlord');
  } else {
    const [count] = await query<{ n: string }>('select count(*)::text as n from landlord');
    if (Number(count!.n) > 1) return json(200, { landlord: null, needsLink: true, items: [] });
  }
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
      where u.status = 'vacant' and ($1::uuid is null or p.landlord_id = $1)
      order by p.name, u.code`,
    [landlord?.id ?? null],
  );

  return json(200, {
    landlord: landlord ? { name: landlord.trading_name } : null,
    needsLink: false,
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
