import { requireLeaseAccess } from '../lib/access';
import { forbidden } from '../lib/http';
import { audit } from '../lib/audit';
import { withTransaction } from '../lib/db';
import { badRequest, conflict, json, notFound, parseBody, route } from '../lib/http';
import { ROOM_TEMPLATE, createInspectionSchema, outgoingWindow } from '../domain/inspection';
import { notify } from '../lib/notify';
import { query } from '../lib/db';
import { isoDate, sastToday } from '../domain/dates';

export const handler = route(async (event) => {
  const leaseId = event.pathParameters?.id;
  if (!leaseId) throw badRequest('A lease id is required.');
  const access = await requireLeaseAccess(event, leaseId);
  if (!access.isLandlord) throw forbidden('Only the landlord opens an inspection.');
  const person = access.person;
  const input = parseBody(event, createInspectionSchema);

  const created = await withTransaction(async (run) => {
    const [lease] = await run<{ id: string; status: string; last_day: string; bedrooms: number; bathrooms: number }>(
      // The tenancy ends on the termination's effective date when notice has been served,
      // which is earlier than end_date on every early cancellation. Anchoring the window to
      // end_date meant no exit inspection could ever be valid for those leases, and without
      // one the law deems the place undamaged: every deduction was forfeited. The notice date
      // wins even when it is later: a lease past its end date runs month to month (CPA s14),
      // and taking the earlier of the two put the window on an end date that had already gone.
      `select l.id, l.status,
              coalesce(t.effective_on, l.end_date)::text as last_day,
              u.bedrooms, u.bathrooms
         from lease l
         join unit u on u.id = l.unit_id
         left join termination t on t.lease_id = l.id and t.status <> 'withdrawn'
        where l.id = $1 for update of l`,
      [leaseId],
    );
    if (!lease) throw notFound('Lease');
    if (!['out_for_signature', 'active'].includes(lease.status)) {
      throw conflict(`This lease is ${lease.status}. Inspections attach to a live lease.`);
    }

    // The move-in inspection is the baseline every exit deduction is measured against. One
    // opened on a renewal when the tenant's move-in was already recorded, or after notice, could
    // only be a new baseline written at exit, so both are refused.
    if (input.kind === 'incoming') {
      const [blocked] = await run<{ earlier: boolean; noticed: boolean }>(
        `with recursive chain(id, depth) as (
           select previous_lease_id, 1 from lease where id = $1 and previous_lease_id is not null
           union all
           select l.previous_lease_id, chain.depth + 1
             from chain join lease l on l.id = chain.id
            where l.previous_lease_id is not null and chain.depth < 50
         )
         select exists (select 1 from chain join inspection i on i.lease_id = chain.id
                         where i.kind = 'incoming' and i.status <> 'missed') as earlier,
                exists (select 1 from termination t where t.lease_id = $1 and t.status <> 'withdrawn') as noticed`,
        [leaseId],
      );
      if (blocked?.earlier) {
        throw conflict('The tenant’s move-in inspection is on the lease this one renews, and it stays the baseline.');
      }
      if (blocked?.noticed) throw conflict('Notice has been served on this lease, so a move-in inspection can no longer be opened.');
    }

    // The outgoing inspection is only valid in the statutory 3 day window before the tenancy ends.
    let window: ReturnType<typeof outgoingWindow> | null = null;
    if (input.kind === 'outgoing') {
      // Booked ahead, so the tenant can be there. One "scheduled" after the day had passed
      // let a landlord sign it alone and keep deductions the law forfeits when nobody inspects.
      const today = sastToday();
      if (isoDate(input.scheduledFor) < today) {
        throw badRequest(`An outgoing inspection cannot be booked in the past. Pick a day from ${today}.`);
      }
      window = outgoingWindow(new Date(`${lease.last_day}T00:00:00Z`));
      if (input.scheduledFor < window.opens || input.scheduledFor > window.closes) {
        throw badRequest(
          `The outgoing inspection must fall in the final 3 days of the tenancy, ${window.opens.toISOString().slice(0, 10)} to ${window.closes.toISOString().slice(0, 10)}.`,
        );
      }
    }

    // One inspection of each kind stands at a time. The end date moves (a lease running month
    // to month is then given notice, or notice follows a booking for the end date), so an exit
    // inspection booked for the old final window is replaced: marked missed, kept for the
    // record, and a new one booked. A completed one inside the current window is the exit
    // inspection, so it stays. A second move-in inspection is refused.
    const [existing] = await run<{ id: string; status: string; scheduled_for: string }>(
      `select id, status, scheduled_for::text from inspection
        where lease_id = $1 and kind = $2 and status <> 'missed' for update`,
      [leaseId, input.kind],
    );
    let replaced: string | null = null;
    if (existing) {
      const inWindow =
        window !== null &&
        existing.scheduled_for >= isoDate(window.opens) &&
        existing.scheduled_for <= isoDate(window.closes);
      if (input.kind === 'incoming') {
        throw conflict('This lease already has a move-in inspection.');
      }
      if (existing.status === 'completed' && inWindow) {
        throw conflict('The exit inspection for this end date has already been completed.');
      }
      await run(`update inspection set status = 'missed' where id = $1`, [existing.id]);
      replaced = existing.id;
    }

    let inspection: { id: string } | undefined;
    try {
      [inspection] = await run<{ id: string }>(
        `insert into inspection (lease_id, kind, scheduled_for) values ($1, $2, $3) returning id`,
        [leaseId, input.kind, input.scheduledFor],
      );
    } catch (error) {
      // Two bookings at once: the other one won.
      if ((error as { code?: string }).code === '23505') {
        throw conflict(`This lease already has an ${input.kind} inspection.`);
      }
      throw error;
    }

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

    return { id: inspection!.id, seeded: rows.length, replaced };
  });

  // A tenant imported without an account is addressed by their applicant row, so the email
  // telling them when to be there still goes out.
  const [tenant] = await query<{ sub: string | null; email: string; phone: string; unit: string }>(
    `select coalesce(a.cognito_sub, 'applicant:' || a.id) as sub, a.email, a.phone, p.name || ' ' || u.code as unit
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
    detail: created.replaced ? { replaced: created.replaced } : undefined,
  });

  return json(201, created);
});
