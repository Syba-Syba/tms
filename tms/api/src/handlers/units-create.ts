import { requireLandlord } from '../lib/auth';
import { audit } from '../lib/audit';
import { query } from '../lib/db';
import { badRequest, conflict, json, notFound, parseBody, route } from '../lib/http';
import { unitSchema } from '../domain/portfolio';

export const handler = route(async (event) => {
  const person = requireLandlord(event);
  const propertyId = event.pathParameters?.id;
  if (!propertyId) throw badRequest('A property id is required.');
  const input = parseBody(event, unitSchema);

  const [property] = await query<{ id: string }>(
    `select p.id from property p
      where p.id = $1 and p.landlord_id = (select landlord_id from landlord_member where sub = $2)`,
    [propertyId, person.sub],
  );
  if (!property) throw notFound('Property');

  try {
    const [unit] = await query<{ id: string }>(
      `insert into unit (property_id, code, bedrooms, bathrooms, monthly_rent_cents, deposit_cents)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [propertyId, input.code, input.bedrooms, input.bathrooms, input.monthlyRentCents, input.depositCents],
    );
    await audit({ actorSub: person.sub, actorRole: 'landlord', action: 'unit.created', entity: 'unit', entityId: unit!.id, detail: { code: input.code } });
    return json(201, { id: unit!.id });
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw conflict(`Unit ${input.code} already exists at this property.`);
    }
    throw error;
  }
});
