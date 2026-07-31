import { requireLandlord } from '../lib/auth';
import { audit } from '../lib/audit';
import { withTransaction } from '../lib/db';
import { badRequest, conflict, json, notFound, route } from '../lib/http';

/** Removing a property never cascades. Its units go first, one by one, each with its own
    history check, so nothing with a paper trail can vanish in a single click. */
export const handler = route(async (event) => {
  const person = requireLandlord(event);
  const propertyId = event.pathParameters?.id;
  if (!propertyId) throw badRequest('A property id is required.');

  await withTransaction(async (run) => {
    const [property] = await run<{ id: string; name: string }>(
      `select p.id, p.name from property p
         join landlord l on l.id = p.landlord_id
        where p.id = $1 and l.cognito_sub = $2
        for update`,
      [propertyId, person.sub],
    );
    if (!property) throw notFound('Property');

    const [units] = await run<{ count: string }>(
      'select count(*) as count from unit where property_id = $1',
      [propertyId],
    );
    if (Number(units!.count) > 0) {
      throw conflict('Remove its units first. A property only goes once it is empty.');
    }

    await run('delete from property where id = $1', [propertyId]);
    await audit({
      actorSub: person.sub,
      actorRole: 'landlord',
      action: 'property.deleted',
      entity: 'property',
      entityId: propertyId,
      detail: { name: property.name },
    });
  });

  return json(200, { removed: true });
});
