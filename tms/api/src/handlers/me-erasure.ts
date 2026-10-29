import { z } from 'zod';
import { audit } from '../lib/audit';
import { caller } from '../lib/auth';
import { query } from '../lib/db';
import { conflict, forbidden, json, parseBody, route } from '../lib/http';
import { erasePerson } from '../lib/privacy';

const schema = z.object({ note: z.string().trim().max(1000).optional() });

/**
 * Asks for one's personal information to be erased (POPIA sections 11(3) and 24).
 *
 * Someone who never applied for anything is only an account, so it goes at once. Anyone who
 * applied or rented has records a landlord is responsible for, so the request waits for each
 * landlord they dealt with. Each erases or refuses for their own records, with a reason; the
 * retention rule decides which they may do. The account itself goes once all have erased.
 */
export const handler = route(async (event) => {
  const person = caller(event);
  if (person.groups.includes('landlord')) {
    throw forbidden('A landlord account holds tenants\' records too, so it is closed through support, not here.');
  }
  const input = parseBody(event, schema);

  const [applicant] = await query<{ id: string }>('select id from applicant where cognito_sub = $1', [person.sub]);
  if (!applicant) {
    await erasePerson(person.sub, { sub: person.sub, role: 'tenant' });
    await query(
      `insert into privacy_request (person_sub, note, status, decided_by, decided_at, response)
       values ($1, $2, 'completed', $1, now(), 'Account deleted. There were no applications or leases to keep.')`,
      [person.sub, input.note ?? null],
    );
    return json(200, { status: 'completed' });
  }

  // Every landlord this person applied to or rented from, one request each, made together.
  const created = await query<{ id: string }>(
    `insert into privacy_request (person_sub, note, landlord_id)
     select $1, $2, landlords.id from (
       select distinct p.landlord_id as id
         from application ap join unit u on u.id = ap.unit_id join property p on p.id = u.property_id
        where ap.applicant_id = $3
       union
       select distinct p.landlord_id
         from lease l join unit u on u.id = l.unit_id join property p on p.id = u.property_id
        where l.applicant_id = $3
     ) landlords
     where not exists (select 1 from privacy_request r where r.person_sub = $1 and r.landlord_id = landlords.id and r.status = 'pending')
     returning id`,
    [person.sub, input.note ?? null, applicant.id],
  );
  if (created.length === 0) throw conflict('You already have a request waiting. Your landlord will answer it.');

  await audit({
    actorSub: person.sub,
    actorRole: 'tenant',
    action: 'privacy.erasure_requested',
    entity: 'privacy_request',
    entityId: created[0]!.id,
    detail: { landlords: created.length },
  });
  return json(201, { status: 'pending', id: created[0]!.id });
});
