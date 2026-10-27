import { landlordIdFor } from '../lib/access';
import { requireLandlord } from '../lib/auth';
import { query } from '../lib/db';
import { badRequest, json, route } from '../lib/http';

const isDate = (value: string | undefined) => !value || /^\d{4}-\d{2}-\d{2}$/.test(value);

export const handler = route(async (event) => {
  const landlordId = await landlordIdFor(requireLandlord(event));
  const { from, to, propertyId } = event.queryStringParameters ?? {};
  if (!isDate(from) || !isDate(to)) throw badRequest('Dates are YYYY-MM-DD.');

  const rows = await query<{
    id: string; property_id: string | null; property: string | null; unit_id: string | null; unit: string | null;
    category: string; description: string; amount_cents: string; incurred_on: string; slip_s3_key: string | null;
  }>(
    `select e.id, e.property_id, p.name as property, e.unit_id, u.code as unit, e.category, e.description,
            e.amount_cents, e.incurred_on::text, e.slip_s3_key
       from expense e
       left join property p on p.id = e.property_id
       left join unit u on u.id = e.unit_id
      where e.landlord_id = $1
        and ($2::date is null or e.incurred_on >= $2)
        and ($3::date is null or e.incurred_on <= $3)
        and ($4::uuid is null or e.property_id = $4)
      order by e.incurred_on desc, e.created_at desc
      limit 1000`,
    [landlordId, from ?? null, to ?? null, propertyId || null],
  );
  return json(200, {
    items: rows.map((row) => ({
      id: row.id,
      propertyId: row.property_id,
      property: row.property,
      unitId: row.unit_id,
      unit: row.unit,
      category: row.category,
      description: row.description,
      amountCents: Number(row.amount_cents),
      incurredOn: row.incurred_on,
      slipKey: row.slip_s3_key,
    })),
  });
});
