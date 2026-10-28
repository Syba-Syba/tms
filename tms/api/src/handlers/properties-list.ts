import { requireLandlord } from '../lib/auth';
import { query } from '../lib/db';
import { forbidden, json, route } from '../lib/http';
import { storage } from '../lib/storage';

interface UnitRow {
  property_id: string;
  property_name: string;
  address_line1: string;
  suburb: string;
  city: string;
  province: string;
  postal_code: string;
  unit_id: string | null;
  code: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  monthly_rent_cents: string | null;
  deposit_cents: string | null;
  unit_status: string | null;
  tenant: string | null;
  lease_id: string | null;
  lease_end: string | null;
  open_applications: string | null;
  description: string | null;
  available_from: string | null;
  furnished: boolean | null;
  pets_allowed: boolean | null;
  parking_bays: number | null;
  listed: boolean | null;
}

export const handler = route(async (event) => {
  const person = requireLandlord(event);
  const [own] = await query<{ id: string }>('select landlord_id as id from landlord_member where sub = $1', [
    person.sub,
  ]);
  if (!own) throw forbidden('No landlord profile is linked to this sign-in.');

  const rows = await query<UnitRow>(
    `select pr.id as property_id, pr.name as property_name, pr.address_line1, pr.suburb,
            pr.city, pr.province, pr.postal_code,
            u.id as unit_id, u.code, u.bedrooms, u.bathrooms,
            u.monthly_rent_cents, u.deposit_cents, u.status as unit_status,
            a.first_name || ' ' || a.last_name as tenant, l.id as lease_id, l.end_date as lease_end,
            (select count(*) from application ap
              where ap.unit_id = u.id and ap.status in ('submitted', 'screening')) as open_applications,
            u.description, u.available_from::text, u.furnished, u.pets_allowed, u.parking_bays, u.listed
       from property pr
       left join unit u on u.property_id = pr.id
       left join lease l on l.unit_id = u.id and l.status = 'active'
       left join applicant a on a.id = l.applicant_id
      where pr.landlord_id = $1
      order by pr.name, u.code`,
    [own.id],
  );

  // Listing photos, for the unit drawer. Links last an hour, like the public page's.
  const unitIds = rows.flatMap((row) => (row.unit_id ? [row.unit_id] : []));
  const photoRows = unitIds.length
    ? await query<{ id: string; unit_id: string; s3_key: string }>(
        'select id, unit_id, s3_key from unit_photo where unit_id = any($1::uuid[]) and uploaded order by position, created_at',
        [unitIds],
      )
    : [];
  const photos = new Map<string, { id: string; url: string }[]>();
  for (const photo of photoRows) {
    const list = photos.get(photo.unit_id) ?? [];
    list.push({ id: photo.id, url: await storage().presignGet(photo.s3_key, 3600) });
    photos.set(photo.unit_id, list);
  }

  const properties = new Map<string, {
    id: string;
    name: string;
    address: string;
    fields: Record<string, string>;
    units: unknown[];
  }>();
  for (const row of rows) {
    if (!properties.has(row.property_id)) {
      properties.set(row.property_id, {
        id: row.property_id,
        name: row.property_name,
        address: `${row.address_line1}, ${row.suburb}, ${row.city}, ${row.province}, ${row.postal_code}`,
        // The parts as well, so the app can edit a property without parsing the line above.
        fields: {
          name: row.property_name,
          addressLine1: row.address_line1,
          suburb: row.suburb,
          city: row.city,
          province: row.province,
          postalCode: row.postal_code,
        },
        units: [],
      });
    }
    if (row.unit_id) {
      properties.get(row.property_id)!.units.push({
        id: row.unit_id,
        code: row.code,
        bedrooms: row.bedrooms,
        bathrooms: row.bathrooms,
        monthlyRentCents: Number(row.monthly_rent_cents),
        depositCents: Number(row.deposit_cents),
        status: row.unit_status,
        tenant: row.tenant,
        leaseId: row.lease_id,
        leaseEnd: row.lease_end,
        openApplications: Number(row.open_applications ?? 0),
        listing: {
          description: row.description,
          availableFrom: row.available_from,
          furnished: Boolean(row.furnished),
          petsAllowed: Boolean(row.pets_allowed),
          parkingBays: row.parking_bays ?? 0,
          listed: row.listed ?? true,
          photos: photos.get(row.unit_id) ?? [],
        },
      });
    }
  }

  return json(200, { items: [...properties.values()] });
});
