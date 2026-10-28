import { requireLandlord } from '../lib/auth';
import { audit } from '../lib/audit';
import { query } from '../lib/db';
import { badRequest, json, notFound, parseBody, route } from '../lib/http';
import { unitUpdateSchema } from '../domain/portfolio';

const COLUMNS: Record<string, string> = {
  code: 'code',
  bedrooms: 'bedrooms',
  bathrooms: 'bathrooms',
  monthlyRentCents: 'monthly_rent_cents',
  depositCents: 'deposit_cents',
};

/** Rent edits apply to the listing only. A signed lease copied its own figures at generation. */
export const handler = route(async (event) => {
  const person = requireLandlord(event);
  const unitId = event.pathParameters?.id;
  if (!unitId) throw badRequest('A unit id is required.');
  const input = parseBody(event, unitUpdateSchema);
  const entries = Object.entries(input).filter(([, value]) => value !== undefined);
  if (entries.length === 0) throw badRequest('Nothing to change.');

  const sets = entries.map(([field], index) => `${COLUMNS[field]} = $${index + 3}`).join(', ');
  const [updated] = await query<{ id: string }>(
    `update unit set ${sets}
      where id = $1 and property_id in (
        select p.id from property p
         where p.landlord_id = (select landlord_id from landlord_member where sub = $2))
      returning id`,
    [unitId, person.sub, ...entries.map(([, value]) => value)],
  );
  if (!updated) throw notFound('Unit');

  await audit({ actorSub: person.sub, actorRole: 'landlord', action: 'unit.updated', entity: 'unit', entityId: unitId, detail: input });
  return json(200, { id: unitId });
});
