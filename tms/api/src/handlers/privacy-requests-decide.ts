import { z } from 'zod';
import { requireOwner } from '../lib/access';
import { audit } from '../lib/audit';
import { requireLandlord } from '../lib/auth';
import { query, withTransaction } from '../lib/db';
import { badRequest, conflict, json, notFound, parseBody, route } from '../lib/http';
import { erasePerson, erasureBlockFor, tellPerson } from '../lib/privacy';

const schema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('erase') }),
  z.object({ decision: z.literal('refuse'), response: z.string().trim().min(10, 'Explain the reason in a sentence.').max(1000) }),
]);

/**
 * The landlord, as responsible party, answers an erasure request for their own records. Erasing
 * is refused by the system while the retention period runs, whatever the landlord clicks;
 * refusing needs a reason the person is sent. The person's account and identity go once every
 * landlord asked has erased.
 */
export const handler = route(async (event) => {
  const requestId = event.pathParameters?.id;
  if (!requestId) throw badRequest('A request id is required.');
  const person = requireLandlord(event);
  // The landlord answers as the responsible party under POPIA, so an agent cannot.
  const { landlordId } = await requireOwner(person);
  const input = parseBody(event, schema);

  const [request] = await query<{ person_sub: string; status: string; email: string; first_name: string; landlord_id: string | null; created_at: string; landlord_name: string }>(
    `select r.person_sub, r.status, a.email, a.first_name, r.landlord_id, r.created_at::text,
            (select trading_name from landlord where id = $2) as landlord_name
       from privacy_request r join applicant a on a.cognito_sub = r.person_sub
      where r.id = $1 and (r.landlord_id = $2 or (r.landlord_id is null and exists (
              select 1 from application ap join unit u on u.id = ap.unit_id join property p on p.id = u.property_id
               where ap.applicant_id = a.id and p.landlord_id = $2)))`,
    [requestId, landlordId],
  );
  if (!request) throw notFound('Request');
  if (request.status !== 'pending') throw conflict('That request has already been answered.');

  if (input.decision === 'erase') {
    // Only this landlord's records, and only their leases count for the retention rule.
    const block = await erasureBlockFor(request.person_sub, landlordId);
    if (block) throw conflict(block);
    await erasePerson(request.person_sub, { sub: person.sub, role: 'landlord' }, { landlordId, identity: false });
    await query(
      `update privacy_request set status = 'completed', decided_by = $2, decided_at = now(),
              response = 'Your personal information has been erased from our records.' where id = $1`,
      [requestId, person.sub],
    );
    // The rest of this request's landlords, asked at the same time. A legacy request had one.
    const [outstanding] = await query<{ open: string }>(
      `select count(*)::text as open from privacy_request
        where person_sub = $1 and created_at = $2::timestamptz and status <> 'completed'`,
      [request.person_sub, request.created_at],
    );
    const everyoneErased = Number(outstanding!.open) === 0;
    if (everyoneErased) {
      await erasePerson(request.person_sub, { sub: person.sub, role: 'landlord' }, { identity: true });
      // Sent to the address captured before erasure; the account it belonged to is gone.
      await tellPerson(
        null, request.person_sub, request.email, 'Your information has been erased',
        `Hi ${request.first_name},\n\nAs you asked, your personal information has been erased from the rental system, ` +
          'and your account and its documents are deleted. This is the last message you will receive from it.',
      );
    } else {
      await tellPerson(
        null, request.person_sub, request.email, `${request.landlord_name} erased your information`,
        `Hi ${request.first_name},\n\n${request.landlord_name} has erased your personal information from their records, as you asked. ` +
          'Your account stays open until every landlord you asked has answered.',
      );
    }
  } else {
    await withTransaction(async (run) => {
      await run(
        `update privacy_request set status = 'refused', decided_by = $2, decided_at = now(), response = $3 where id = $1`,
        [requestId, person.sub, input.response],
      );
      await tellPerson(
        run, request.person_sub, request.email, 'About your request to erase your information',
        `Hi ${request.first_name},\n\nYour request to erase your personal information was not carried out.\n\n` +
          `${input.response}\n\nIf you disagree, you can complain to the Information Regulator at https://inforegulator.org.za.`,
      );
    });
  }

  await audit({
    actorSub: person.sub,
    actorRole: 'landlord',
    action: `privacy.request_${input.decision === 'erase' ? 'completed' : 'refused'}`,
    entity: 'privacy_request',
    entityId: requestId,
  });
  return json(200, { status: input.decision === 'erase' ? 'completed' : 'refused' });
});
