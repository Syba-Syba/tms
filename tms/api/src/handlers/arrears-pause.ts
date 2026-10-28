import { z } from 'zod';
import { requireLeaseAccess } from '../lib/access';
import { audit } from '../lib/audit';
import { query } from '../lib/db';
import { badRequest, conflict, forbidden, json, parseBody, route } from '../lib/http';
import { addDaysIso, sastToday } from '../domain/dates';
import { MAX_PAUSE_DAYS } from '../domain/arrears';

const pauseSchema = z.object({
  // null resumes the reminders.
  until: z.iso.date().nullable(),
  reason: z.string().trim().min(3).max(200).optional(),
});

/** The landlord holds the automatic reminders: a payment plan, a dispute, a death in the family.
    A pause has an end date, so reminders never stay off by accident. */
export const handler = route(async (event) => {
  const leaseId = event.pathParameters?.id;
  if (!leaseId) throw badRequest('A lease id is required.');
  const access = await requireLeaseAccess(event, leaseId);
  if (!access.isLandlord) throw forbidden('Only the landlord pauses reminders.');
  const input = parseBody(event, pauseSchema);

  const today = sastToday();
  if (input.until) {
    if (!input.reason) throw badRequest('Say why the reminders are paused.');
    if (input.until < today) throw badRequest('Pick a date from today on.');
    if (input.until > addDaysIso(today, MAX_PAUSE_DAYS)) {
      throw badRequest(`A pause can run for ${MAX_PAUSE_DAYS} days at most. Pause again when it ends.`);
    }
  }

  const [updated] = await query<{ id: string }>(
    `update arrears_case set paused_until = $2, pause_reason = $3, paused_by = $4
      where lease_id = $1 and closed_on is null returning id`,
    [leaseId, input.until, input.until ? input.reason : null, input.until ? access.person.sub : null],
  );
  if (!updated) throw conflict('There are no open arrears on this lease to pause.');

  await audit({
    actorSub: access.person.sub,
    actorRole: 'landlord',
    action: input.until ? 'arrears.paused' : 'arrears.resumed',
    entity: 'lease',
    entityId: leaseId,
    detail: input.until ? { until: input.until, reason: input.reason } : {},
  });
  return json(200, { pausedUntil: input.until });
});
