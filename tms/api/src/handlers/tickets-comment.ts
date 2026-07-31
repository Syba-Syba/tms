import { requireLeaseAccessVia } from '../lib/access';
import { query } from '../lib/db';
import { badRequest, forbidden, json, notFound, parseBody, route } from '../lib/http';
import { commentSchema } from '../domain/ticket';

export const handler = route(async (event) => {
  const ticketId = event.pathParameters?.id;
  if (!ticketId) throw badRequest('A ticket id is required.');
  const access = await requireLeaseAccessVia(
    event,
    'select lease_id from ticket where id = $1',
    [ticketId],
    'Ticket',
  );
  const person = access.person;
  const input = parseBody(event, commentSchema);

  const [ticket] = await query<{ id: string; tenant_sub: string | null; status: string }>(
    `select t.id, a.cognito_sub as tenant_sub, t.status
       from ticket t
       join lease l on l.id = t.lease_id
       join applicant a on a.id = l.applicant_id
      where t.id = $1`,
    [ticketId],
  );
  if (!ticket) throw notFound('Ticket');
  const isTenant = ticket.tenant_sub === person.sub;
  const isLandlord = person.groups.includes('landlord');
  if (!isTenant && !isLandlord) throw forbidden('Only the parties on the lease can comment.');
  if (['closed', 'cancelled'].includes(ticket.status)) {
    throw badRequest('This ticket is closed. Raise a new one if the problem is back.');
  }

  await query(
    `insert into ticket_event (ticket_id, actor_role, kind, note) values ($1, $2, 'comment', $3)`,
    [ticketId, isTenant ? 'tenant' : 'landlord', input.note],
  );
  return json(201, { ok: true });
});
