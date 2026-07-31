import { requireLeaseAccessVia } from '../lib/access';
import { forbidden } from '../lib/http';
import { audit } from '../lib/audit';
import { withTransaction } from '../lib/db';
import { badRequest, conflict, json, notFound, parseBody, route } from '../lib/http';
import { actionSchema, canMove } from '../domain/ticket';
import { notify } from '../lib/notify';
import { query } from '../lib/db';

const NEXT: Record<string, string> = {
  assign: 'assigned',
  quote: 'quote_pending',
  approve_quote: 'quote_approved',
  start: 'in_progress',
  complete: 'done',
  cancel: 'cancelled',
};

export const handler = route(async (event) => {
  const ticketId = event.pathParameters?.id;
  if (!ticketId) throw badRequest('A ticket id is required.');
  const access = await requireLeaseAccessVia(
    event,
    'select lease_id from ticket where id = $1',
    [ticketId],
    'Ticket',
  );
  if (!access.isLandlord) throw forbidden('Only the landlord moves a ticket along.');
  const person = access.person;
  const input = parseBody(event, actionSchema);

  const result = await withTransaction(async (run) => {
    const [ticket] = await run<{ id: string; status: string; lease_id: string }>(
      'select id, status, lease_id from ticket where id = $1 for update',
      [ticketId],
    );
    if (!ticket) throw notFound('Ticket');
    const next = NEXT[input.action]!;
    if (!canMove(ticket.status, next)) {
      throw conflict(`A ${ticket.status} ticket cannot move to ${next}.`);
    }

    let note: string | null = null;

    if (input.action === 'assign') {
      const [landlordRow] = await run<{ landlord_id: string }>(
        `select p.landlord_id from lease l
           join unit u on u.id = l.unit_id join property p on p.id = u.property_id
          where l.id = $1`,
        [ticket.lease_id],
      );
      const [contractor] = await run<{ id: string; name: string }>(
        `insert into contractor (landlord_id, name, trade, phone, email)
         values ($1, $2, $3, $4, $5)
         on conflict (landlord_id, phone) do update set name = excluded.name, trade = excluded.trade
         returning id, name`,
        [landlordRow!.landlord_id, input.contractor.name, input.contractor.trade,
         input.contractor.phone, input.contractor.email ?? null],
      );
      await run('update ticket set contractor_id = $2 where id = $1', [ticketId, contractor!.id]);
      note = `${contractor!.name} · ${input.contractor.trade}`;
    }

    if (input.action === 'quote') {
      await run('update ticket set quote_cents = $2 where id = $1', [ticketId, input.quoteCents]);
      note = input.note ?? `R ${(input.quoteCents / 100).toFixed(2)}`;
    }
    if (input.action === 'approve_quote') {
      await run('update ticket set quote_approved_at = now() where id = $1', [ticketId]);
    }
    if (input.action === 'complete') {
      await run('update ticket set completed_at = now() where id = $1', [ticketId]);
      note = input.note ?? null;
    }
    if (input.action === 'cancel') note = input.note ?? null;

    await run('update ticket set status = $2 where id = $1', [ticketId, next]);
    await run(
      `insert into ticket_event (ticket_id, actor_role, kind, note) values ($1, 'landlord', $2, $3)`,
      [ticketId, input.action === 'approve_quote' ? 'quote_approved' :
                 input.action === 'quote' ? 'quote_added' :
                 input.action === 'assign' ? 'assigned' :
                 input.action === 'start' ? 'started' :
                 input.action === 'complete' ? 'completed' : 'cancelled', note],
    );
    return { status: next };
  });

  if (input.action === 'assign' || input.action === 'complete') {
    const [context] = await query<{
      lease_id: string; title: string; unit: string; contractor: string | null; trade: string | null;
      phone: string | null; tenant_sub: string | null; tenant_email: string; tenant_phone: string;
    }>(
      `select t.lease_id, t.title, p.name || ' ' || u.code as unit,
              c.name as contractor, c.trade, c.phone,
              a.cognito_sub as tenant_sub, a.email as tenant_email, a.phone as tenant_phone
         from ticket t
         join lease l on l.id = t.lease_id
         join unit u on u.id = l.unit_id
         join property p on p.id = u.property_id
         join applicant a on a.id = l.applicant_id
         left join contractor c on c.id = t.contractor_id
        where t.id = $1`,
      [ticketId],
    );
    if (context?.tenant_sub) {
      await notify({
        leaseId: context.lease_id,
        to: { sub: context.tenant_sub, email: context.tenant_email, phone: context.tenant_phone },
        kind: input.action === 'assign' ? 'ticket_assigned' : 'ticket_done',
        data: {
          title: context.title,
          unit: context.unit,
          contractor: context.contractor ?? 'A contractor',
          trade: context.trade ?? 'maintenance',
          phone: context.phone ?? 'the number on file',
        },
      });
    }
  }

  await audit({
    actorSub: person.sub,
    actorRole: 'landlord',
    action: `ticket.${input.action}`,
    entity: 'ticket',
    entityId: ticketId,
  });

  return json(200, result);
});
