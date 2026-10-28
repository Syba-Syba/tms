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
 * applied or rented has records a landlord is responsible for, so the request waits for the
 * landlord, who erases it or refuses with a reason; the retention rule decides which they may do.
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

  const created = await query<{ id: string }>(
    `insert into privacy_request (person_sub, note) values ($1, $2)
     on conflict (person_sub) where status = 'pending' do nothing returning id`,
    [person.sub, input.note ?? null],
  );
  if (created.length === 0) throw conflict('You already have a request waiting. Your landlord will answer it.');

  await audit({
    actorSub: person.sub,
    actorRole: 'tenant',
    action: 'privacy.erasure_requested',
    entity: 'privacy_request',
    entityId: created[0]!.id,
  });
  return json(201, { status: 'pending', id: created[0]!.id });
});
