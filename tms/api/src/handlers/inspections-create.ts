import { requireLeaseAccess } from '../lib/access';
import { forbidden } from '../lib/http';
import { audit } from '../lib/audit';
import { withTransaction } from '../lib/db';
import { badRequest, conflict, json, notFound, parseBody, route } from '../lib/http';
import { ROOM_TEMPLATE, createInspectionSchema, outgoingWindow } from '../domain/inspection';
import { notify } from '../lib/notify';
import { query } from '../lib/db';

export const handler = route(async (event) => {
  const leaseId = event.pathParameters?.id;
  if (!leaseId) throw badRequest('A lease id is required.');
  const access = await requireLeaseAccess(event, leaseId);
  if (!access.isLandlord) throw forbidden('Only the landlord opens an inspection.');
  const person = access.person;
  const input = parseBody(event, createInspectionSchema);

  const created = await withTransaction(async (run) => {
    const [lease] = await run<{ id: string; status: string; end_date: string; bedrooms: number; bathrooms: number }>(
      `select l.id, l.status, l.end_date, u.bedrooms, u.bathrooms
         from lease l join unit u on u.id = l.unit_id
        where l.id = $1 for update`,
      [leaseId],
    );
    if (!lease) throw notFound('Lease');
    if (!['out_for_signature', 'active'].includes(lease.status)) {
      throw conflict(`This lease is ${lease.status}. Inspections attach to a live lease.`);
    }

    // The outgoing inspection is only valid in the statutory 3 day window before lease end.
    if (input.kind === 'outgoing') {
      const window = outgoingWindow(new Date(lease.end_date));
      if (input.scheduledFor < window.opens || input.scheduledFor > window.closes) {
        throw badRequest(
          `The outgoing inspection must fall in the final 3 days of the lease, ${window.opens.toISOString().slice(0, 10)} to ${window.closes.toISOString().slice(0, 10)}.`,
        );
      }
    }

    const [inspection] = await run<{ id: string }>(
      `insert into inspection (lease_id, kind, scheduled_for) values ($1, $2, $3) returning id`,
      [leaseId, input.kind, input.scheduledFor],
    );

    // Seed the walkthrough: one bedroom and bathroom block per unit count.
    const rows: [string, string][] = [];
    for (const [room, items] of Object.entries(ROOM_TEMPLATE)) {
      const copies = room === 'Bedroom' ? lease.bedrooms : room === 'Bathroom' ? lease.bathrooms : 1;
      for (let index = 1; index <= copies; index += 1) {
        const label = copies > 1 ? `${room} ${index}` : room;
        for (const item of items) rows.push([label, item]);
      }
    }
    for (const [room, item] of rows) {
      await run(
        `insert into inspection_finding (inspection_id, room, item) values ($1, $2, $3)`,
        [inspection!.id, room, item],
      );
    }

    return { id: inspection!.id, seeded: rows.length };
  });

  const [tenant] = await query<{ sub: string | null; email: string; phone: string; unit: string }>(
    `select a.cognito_sub as sub, a.email, a.phone, p.name || ' ' || u.code as unit
       from lease l
       join applicant a on a.id = l.applicant_id
       join unit u on u.id = l.unit_id
       join property p on p.id = u.property_id
      where l.id = $1`,
    [leaseId],
  );
  if (tenant?.sub) {
    await notify({
      leaseId,
      to: { sub: tenant.sub, email: tenant.email, phone: tenant.phone },
      kind: 'inspection_scheduled',
      dedupeKey: `inspection_scheduled:${created.id}`,
      data: {
        unit: tenant.unit,
        date: input.scheduledFor.toISOString().slice(0, 10),
        kindLabel: input.kind === 'incoming' ? 'Move-in' : 'Move-out',
        consequence:
          input.kind === 'outgoing'
            ? 'If it does not happen, the law treats the place as undamaged and nothing can be deducted from your deposit.'
            : 'The defects list from this inspection becomes part of your lease.',
      },
    });
  }

  await audit({
    actorSub: person.sub,
    actorRole: 'landlord',
    action: `inspection.${input.kind}.created`,
    entity: 'inspection',
    entityId: created.id,
  });

  return json(201, created);
});
