import { query } from '../lib/db';
import { badRequest, json, notFound, route } from '../lib/http';
import { storage } from '../lib/storage';

/** Photo links last an hour: long enough to browse, short enough that a copied link dies. */
const PHOTO_LINK_SECONDS = 3600;

/**
 * GET /listings?landlord=slug: one landlord's vacant units, with photos, for anyone. It is the
 * page a landlord shares on Property24, Facebook or WhatsApp, so it needs no sign-in and shows
 * nothing about tenants: only the unit, its rent and its photos.
 */
export const handler = route(async (event) => {
  const slug = event.queryStringParameters?.landlord?.trim().toLowerCase() ?? '';
  if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(slug)) throw badRequest('Which landlord? The link ends with their name.');
  const [landlord] = await query<{ id: string; trading_name: string; phone: string; email: string }>(
    'select id, trading_name, phone, email from landlord where slug = $1',
    [slug],
  );
  if (!landlord) throw notFound('Landlord');

  const units = await query<{
    id: string; code: string; bedrooms: number; bathrooms: number; monthly_rent_cents: string; deposit_cents: string;
    description: string | null; available_from: string | null; furnished: boolean; pets_allowed: boolean;
    parking_bays: number; property_name: string; suburb: string; city: string;
  }>(
    `select u.id, u.code, u.bedrooms, u.bathrooms, u.monthly_rent_cents::text, u.deposit_cents::text,
            u.description, u.available_from::text, u.furnished, u.pets_allowed, u.parking_bays,
            p.name as property_name, p.suburb, p.city
       from unit u join property p on p.id = u.property_id
      where p.landlord_id = $1 and u.status = 'vacant' and u.listed
      order by u.monthly_rent_cents, p.name, u.code`,
    [landlord.id],
  );
  const photos = units.length
    ? await query<{ unit_id: string; s3_key: string }>(
        `select unit_id, s3_key from unit_photo where unit_id = any($1::uuid[]) and uploaded order by position, created_at`,
        [units.map((unit) => unit.id)],
      )
    : [];
  const store = storage();
  const photoUrls = new Map<string, string[]>();
  for (const photo of photos) {
    const list = photoUrls.get(photo.unit_id) ?? [];
    list.push(await store.presignGet(photo.s3_key, PHOTO_LINK_SECONDS));
    photoUrls.set(photo.unit_id, list);
  }

  return json(200, {
    landlord: { name: landlord.trading_name, phone: landlord.phone, email: landlord.email, slug },
    items: units.map((unit) => ({
      id: unit.id,
      // The street address stays off a public page: the suburb is enough to decide to apply.
      label: `${unit.property_name} ${unit.code}`,
      suburb: unit.suburb,
      city: unit.city,
      bedrooms: unit.bedrooms,
      bathrooms: unit.bathrooms,
      monthlyRentCents: Number(unit.monthly_rent_cents),
      depositCents: Number(unit.deposit_cents),
      description: unit.description,
      availableFrom: unit.available_from,
      furnished: unit.furnished,
      petsAllowed: unit.pets_allowed,
      parkingBays: unit.parking_bays,
      photos: photoUrls.get(unit.id) ?? [],
    })),
  });
});
