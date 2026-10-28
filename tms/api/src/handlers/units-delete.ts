import { requireLandlord } from '../lib/auth';
import { audit } from '../lib/audit';
import { withTransaction } from '../lib/db';
import { badRequest, conflict, json, notFound, route } from '../lib/http';

/** A unit disappears only if nothing ever happened in it. Leases, invoices and deposit
    records are the paper trail a dispute runs on, so a unit with history is refused rather
    than cascaded away. */
export const handler = route(async (event) => {
  const person = requireLandlord(event);
  const unitId = event.pathParameters?.id;
  if (!unitId) throw badRequest('A unit id is required.');

  await withTransaction(async (run) => {
    const [unit] = await run<{ id: string; code: string }>(
      `select u.id, u.code from unit u
         join property p on p.id = u.property_id
         join landlord l on l.id = p.landlord_id
        where u.id = $1 and l.cognito_sub = $2
        for update`,
      [unitId, person.sub],
    );
    if (!unit) throw notFound('Unit');

    const [leases] = await run<{ count: string }>(
      'select count(*) as count from lease where unit_id = $1',
      [unitId],
    );
    if (Number(leases!.count) > 0) {
      throw conflict(
        'This unit has lease history. Its invoices and deposit records must stay on file, so it cannot be removed.',
      );
    }

    const [applications] = await run<{ count: string }>(
      'select count(*) as count from application where unit_id = $1',
      [unitId],
    );
    if (Number(applications!.count) > 0) {
      throw conflict(
        'People have applied for this unit. Applications are part of the record, so it cannot be removed.',
      );
    }

    await run('delete from unit where id = $1', [unitId]);
    await audit(
      {
        actorSub: person.sub,
        actorRole: 'landlord',
        action: 'unit.deleted',
        entity: 'unit',
        entityId: unitId,
        detail: { code: unit.code },
      },
      run,
    );
  });

  return json(200, { removed: true });
});
