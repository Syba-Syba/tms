import { requireLandlord } from '../lib/auth';
import { audit } from '../lib/audit';
import { query } from '../lib/db';
import { badRequest, json, notFound, parseBody, route } from '../lib/http';
import { propertyUpdateSchema } from '../domain/portfolio';

const COLUMNS: Record<string, string> = {
  name: 'name',
  addressLine1: 'address_line1',
  suburb: 'suburb',
  city: 'city',
  province: 'province',
  postalCode: 'postal_code',
};

export const handler = route(async (event) => {
  const person = requireLandlord(event);
  const propertyId = event.pathParameters?.id;
  if (!propertyId) throw badRequest('A property id is required.');
  const input = parseBody(event, propertyUpdateSchema);
  const entries = Object.entries(input).filter(([, value]) => value !== undefined);
  if (entries.length === 0) throw badRequest('Nothing to change.');

  const sets = entries.map(([field], index) => `${COLUMNS[field]} = $${index + 3}`).join(', ');
  const [updated] = await query<{ id: string }>(
    `update property set ${sets}
      where id = $1 and landlord_id = (select landlord_id from landlord_member where sub = $2)
      returning id`,
    [propertyId, person.sub, ...entries.map(([, value]) => value)],
  );
  if (!updated) throw notFound('Property');

  await audit({ actorSub: person.sub, actorRole: 'landlord', action: 'property.updated', entity: 'property', entityId: propertyId, detail: input });
  return json(200, { id: propertyId });
});
