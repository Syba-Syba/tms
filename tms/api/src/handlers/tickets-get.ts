import { requireLeaseAccessVia } from '../lib/access';
import { query } from '../lib/db';
import { badRequest, json, notFound, route } from '../lib/http';

/** A ticket with its whole history. The event table is both the status timeline and the
    message thread, so one query returns both interleaved in order. */
export const handler = route(async (event) => {
  const ticketId = event.pathParameters?.id;
  if (!ticketId) throw badRequest('A ticket id is required.');
  const access = await requireLeaseAccessVia(
    event,
    'select lease_id from ticket where id = $1',
    [ticketId],
    'Ticket',
  );

  const [ticket] = await query<{
    id: string; lease_id: string; title: string; description: string; category: string;
    severity: string; status: string; target_by: string; created_at: string;
    quote_cents: string | null; quote_approved_at: string | null; rating: number | null;
    rating_note: string | null; unit: string; tenant: string;
    contractor: string | null; trade: string | null; phone: string | null; overdue: boolean;
  }>(
    `select t.id, t.lease_id, t.title, t.description, t.category, t.severity, t.status,
            t.target_by::text, t.created_at::text, t.quote_cents, t.quote_approved_at::text,
            t.rating, t.rating_note,
            p.name || ' ' || u.code as unit,
            a.first_name || ' ' || a.last_name as tenant,
            c.name as contractor, c.trade, c.phone,
            (t.target_by < now() and t.status not in ('done','closed','cancelled')) as overdue
       from ticket t
       join lease l on l.id = t.lease_id
       join unit u on u.id = l.unit_id
       join property p on p.id = u.property_id
       join applicant a on a.id = l.applicant_id
       left join contractor c on c.id = t.contractor_id
      where t.id = $1`,
    [ticketId],
  );
  if (!ticket) throw notFound('Ticket');

  const events = await query<{ at: string; actor_role: string; kind: string; note: string | null }>(
    `select at::text, actor_role, kind, note from ticket_event
      where ticket_id = $1 order by at`,
    [ticketId],
  );

  const photos = await query<{ id: string; phase: string; s3_key: string }>(
    'select id, phase, s3_key from ticket_photo where ticket_id = $1 order by uploaded_at',
    [ticketId],
  );

  return json(200, {
    id: ticket.id,
    leaseId: ticket.lease_id,
    title: ticket.title,
    description: ticket.description,
    category: ticket.category,
    severity: ticket.severity,
    status: ticket.status,
    targetBy: ticket.target_by,
    overdue: ticket.overdue,
    unit: ticket.unit,
    tenant: ticket.tenant,
    contractor: ticket.contractor
      ? { name: ticket.contractor, trade: ticket.trade, phone: ticket.phone }
      : null,
    quoteCents: ticket.quote_cents ? Number(ticket.quote_cents) : null,
    quoteApproved: Boolean(ticket.quote_approved_at),
    rating: ticket.rating,
    ratingNote: ticket.rating_note,
    events,
    photos: photos.map((row) => ({ id: row.id, phase: row.phase, key: row.s3_key })),
    // The UI should not have to re-derive the state machine.
    viewer: { isLandlord: access.isLandlord, isTenant: access.isTenant },
  });
});
