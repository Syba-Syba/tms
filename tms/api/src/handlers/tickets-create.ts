import { requireLeaseAccess } from '../lib/access';
import { audit } from '../lib/audit';
import { withTransaction } from '../lib/db';
import { badRequest, json, notFound, parseBody, route } from '../lib/http';
import { createTicketSchema, targetBy } from '../domain/ticket';
import { notify } from '../lib/notify';
import { query } from '../lib/db';

export const handler = route(async (event) => {
  const leaseId = event.pathParameters?.id;
  if (!leaseId) throw badRequest('A lease id is required.');
  const access = await requireLeaseAccess(event, leaseId);
  const person = access.person;
  const input = parseBody(event, createTicketSchema);

  const ticket: { id: string; targetBy: string; isTenant: boolean } = await withTransaction(async (run) => {
    const [lease] = await run<{ status: string }>('select status from lease where id = $1', [leaseId]);
    if (!lease) throw notFound('Lease');
    if (lease.status !== 'active') throw badRequest('Tickets attach to an active lease.');
    const isTenant = access.isTenant;

    const due = targetBy(input.severity);
    const [created] = await run<{ id: string }>(
      `insert into ticket (lease_id, category, severity, title, description, target_by, created_by)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [leaseId, input.category, input.severity, input.title, input.description, due, person.sub],
    );
    await run(
      `insert into ticket_event (ticket_id, actor_role, kind, note) values ($1, $2, 'created', $3)`,
      [created!.id, isTenant ? 'tenant' : 'landlord', input.title],
    );
    return { id: created!.id, targetBy: due.toISOString(), isTenant };
  });

  const [context] = await query<{
    landlord_sub: string | null; landlord_email: string; unit: string; tenant: string;
  }>(
    `select ll.cognito_sub as landlord_sub, ll.email as landlord_email,
            p.name || ' ' || u.code as unit,
            a.first_name || ' ' || a.last_name as tenant
       from lease l
       join unit u on u.id = l.unit_id
       join property p on p.id = u.property_id
       join landlord ll on ll.id = p.landlord_id
       join applicant a on a.id = l.applicant_id
      where l.id = $1`,
    [leaseId],
  );
  if (context?.landlord_sub) {
    await notify({
      leaseId,
      to: { sub: context.landlord_sub, email: context.landlord_email },
      kind: 'ticket_raised',
      data: {
        title: input.title,
        description: input.description,
        unit: context.unit,
        tenant: context.tenant,
        severityLabel: input.severity.charAt(0).toUpperCase() + input.severity.slice(1),
        targetBy: ticket.targetBy.slice(0, 16).replace('T', ' '),
      },
    });
  }

  const isTenantActor = ticket.isTenant;
  await audit({
    actorSub: person.sub,
    actorRole: isTenantActor ? 'tenant' : 'landlord',
    action: 'ticket.created',
    entity: 'ticket',
    entityId: ticket.id,
    detail: { severity: input.severity, category: input.category },
  });

  return json(201, ticket);
});
