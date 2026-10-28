import { membershipOf } from '../lib/access';
import { requireLandlord } from '../lib/auth';
import { query } from '../lib/db';
import { json, notFound, route } from '../lib/http';
import { accountById, bankOf } from '../lib/landlord-account';

/** The landlord account behind this sign-in, the caller's place on it, and how far setup has got. */
export const handler = route(async (event) => {
  const person = requireLandlord(event);
  const { landlordId, role } = await membershipOf(person);
  const account = await accountById(landlordId);
  if (!account) throw notFound('Account');

  const [counts] = await query<{ properties: string; units: string; leases: string; team: string }>(
    `select (select count(*) from property where landlord_id = $1)::text as properties,
            (select count(*) from unit u join property p on p.id = u.property_id where p.landlord_id = $1)::text as units,
            (select count(*) from lease l join unit u on u.id = l.unit_id join property p on p.id = u.property_id
              where p.landlord_id = $1)::text as leases,
            (select count(*) from landlord_member where landlord_id = $1)::text as team`,
    [landlordId],
  );
  const bank = bankOf(account);
  const onboarding = {
    bank: Boolean(bank),
    property: Number(counts!.properties) > 0,
    unit: Number(counts!.units) > 0,
    // A landlord with a tenant already on a lease has nothing left to learn from a checklist.
    tenant: Number(counts!.leases) > 0,
  };

  return json(200, {
    account: {
      id: account.id,
      tradingName: account.trading_name,
      email: account.email,
      phone: account.phone,
      registrationNo: account.registration_no,
      vatNo: account.vat_no,
      slug: account.slug,
      bank,
    },
    me: { role },
    teamSize: Number(counts!.team),
    onboarding: { ...onboarding, done: onboarding.bank && onboarding.property && onboarding.unit },
  });
});
