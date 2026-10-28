import { query } from './db';
import { badRequest } from './http';

/**
 * Checks that a property, and a unit if given, belong to this landlord, and that the unit is in
 * that property. Anything else answers as not found, so ids from another landlord reveal nothing.
 */
export async function assertOwnedPlace(
  landlordId: string,
  propertyId: string | null | undefined,
  unitId: string | null | undefined,
): Promise<void> {
  if (unitId && !propertyId) throw badRequest('Pick the property the unit is in.');
  if (!propertyId) return;
  const rows = await query(
    `select 1 from property p
       left join unit u on u.property_id = p.id and u.id = $3
      where p.id = $1 and p.landlord_id = $2 and ($3::uuid is null or u.id is not null)`,
    [propertyId, landlordId, unitId ?? null],
  );
  if (rows.length === 0) throw badRequest('That property or unit was not found.');
}
