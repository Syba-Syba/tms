import { requireLeaseAccessVia } from '../lib/access';
import { audit } from '../lib/audit';
import { withTransaction } from '../lib/db';
import { badRequest, conflict, forbidden, json, notFound, parseBody, route } from '../lib/http';
import { closeSchema } from '../domain/ticket';

/** Only the tenant closes, only after the work is done, and never without a rating.
    The rating is the contractor's track record; skipping it makes the next assignment blind. */
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
  const input = parseBody(event, closeSchema);

  await withTransaction(async (run) => {
    const [ticket] = await run<{ id: string; status: string; tenant_sub: string | null }>(
      `select t.id, t.status, a.cognito_sub as tenant_sub
         from ticket t
         join lease l on l.id = t.lease_id
         join applicant a on a.id = l.applicant_id
        where t.id = $1 for update`,
      [ticketId],
    );
    if (!ticket) throw notFound('Ticket');
    if (ticket.tenant_sub !== person.sub) throw forbidden('Only the tenant can close a ticket.');
    if (ticket.status !== 'done') throw conflict('Close it after the work is marked done.');

    await run(
      `update ticket set status = 'closed', closed_at = now(), rating = $2, rating_note = $3
        where id = $1`,
      [ticketId, input.rating, input.note ?? null],
    );
    await run(
      `insert into ticket_event (ticket_id, actor_role, kind, note) values ($1, 'tenant', 'closed', $2)`,
      [ticketId, `${input.rating}/5${input.note ? ` · ${input.note}` : ''}`],
    );
  });

  await audit({
    actorSub: person.sub,
    actorRole: 'tenant',
    action: 'ticket.closed',
    entity: 'ticket',
    entityId: ticketId,
    detail: { rating: input.rating },
  });

  return json(200, { status: 'closed' });
});
