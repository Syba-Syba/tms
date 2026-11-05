import { z } from 'zod';
import { requireLeaseAccessVia } from '../lib/access';
import { audit } from '../lib/audit';
import { query, withTransaction } from '../lib/db';
import { badRequest, conflict, forbidden, json, notFound, parseBody, route } from '../lib/http';
import { closeSchema } from '../domain/ticket';

/** How long a finished ticket waits for the tenant before the landlord may close it. */
export const LANDLORD_CLOSE_AFTER_DAYS = 7;

/** The landlord closes without a rating: the rating is the tenant's to give. */
const landlordCloseSchema = z.object({ note: z.string().max(1000).optional() });

/** The tenant closes, only after the work is done, and never without a rating.
    The rating is the contractor's track record; skipping it makes the next assignment blind.
    A tenant imported without an account cannot sign in to close anything, and a tenant who
    simply never does left the ticket at 'done' for ever. So once it has been done for a week,
    the landlord may close it too, with no rating. */
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

  const [current] = await query<{ tenant_sub: string | null }>(
    `select a.cognito_sub as tenant_sub
       from ticket t join lease l on l.id = t.lease_id join applicant a on a.id = l.applicant_id
      where t.id = $1`,
    [ticketId],
  );
  const asTenant = current?.tenant_sub != null && current.tenant_sub === person.sub;
  if (!asTenant && !access.isLandlord) throw forbidden('Only the tenant can close a ticket.');
  const input = asTenant
    ? parseBody(event, closeSchema)
    : { ...parseBody(event, landlordCloseSchema), rating: null as number | null };

  await withTransaction(async (run) => {
    const [ticket] = await run<{ id: string; status: string; done_long_enough: boolean }>(
      `select t.id, t.status,
              coalesce(t.completed_at <= now() - make_interval(days => $2::int), false) as done_long_enough
         from ticket t
        where t.id = $1 for update`,
      [ticketId, LANDLORD_CLOSE_AFTER_DAYS],
    );
    if (!ticket) throw notFound('Ticket');
    if (ticket.status !== 'done') throw conflict('Close it after the work is marked done.');
    if (!asTenant && !ticket.done_long_enough) {
      throw forbidden(
        `The tenant closes and rates the work. If they have not after ${LANDLORD_CLOSE_AFTER_DAYS} days, you can close it.`,
      );
    }

    await run(
      `update ticket set status = 'closed', closed_at = now(), rating = $2, rating_note = $3
        where id = $1`,
      [ticketId, input.rating, input.note ?? null],
    );
    const note = asTenant
      ? `${input.rating}/5${input.note ? ` · ${input.note}` : ''}`
      : `Closed by the landlord after ${LANDLORD_CLOSE_AFTER_DAYS} days without a rating${input.note ? ` · ${input.note}` : ''}`;
    await run(
      `insert into ticket_event (ticket_id, actor_role, kind, note) values ($1, $2, 'closed', $3)`,
      [ticketId, asTenant ? 'tenant' : 'landlord', note],
    );
  });

  await audit({
    actorSub: person.sub,
    actorRole: asTenant ? 'tenant' : 'landlord',
    action: 'ticket.closed',
    entity: 'ticket',
    entityId: ticketId,
    detail: asTenant ? { rating: input.rating } : { rating: null, closedBy: 'landlord' },
  });

  return json(200, { status: 'closed' });
});
