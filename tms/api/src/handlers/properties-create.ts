import { requireLandlord } from '../lib/auth';
import { audit } from '../lib/audit';
import { query } from '../lib/db';
import { forbidden, json, parseBody, route } from '../lib/http';
import { propertySchema } from '../domain/portfolio';

export const handler = route(async (event) => {
  const person = requireLandlord(event);
  const [own] = await query<{ id: string }>('select landlord_id as id from landlord_member where sub = $1', [
    person.sub,
  ]);
  if (!own) throw forbidden('No landlord profile is linked to this sign-in.');
  const input = parseBody(event, propertySchema);

  const [property] = await query<{ id: string }>(
    `insert into property (landlord_id, name, address_line1, suburb, city, province, postal_code)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [own.id, input.name, input.addressLine1, input.suburb, input.city, input.province, input.postalCode],
  );

  await audit({ actorSub: person.sub, actorRole: 'landlord', action: 'property.created', entity: 'property', entityId: property!.id, detail: { name: input.name } });
  return json(201, { id: property!.id });
});
