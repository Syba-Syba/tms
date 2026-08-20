import { requireApplicationAccess } from '../lib/access';
import { requireLandlord } from '../lib/auth';
import { audit } from '../lib/audit';
import { withTransaction } from '../lib/db';
import { badRequest, conflict, forbidden, json, notFound, parseBody, route } from '../lib/http';
import { decisionSchema } from '../domain/application';

export const handler = route(async (event) => {
  const person = requireLandlord(event);
  const id = event.pathParameters?.id;
  if (!id) throw badRequest('An application id is required.');
  const input = parseBody(event, decisionSchema);

  // Being a landlord is not the same as being this unit's landlord. Without this, any landlord
  // could approve or decline an application made against another landlord's property.
  const access = await requireApplicationAccess(event, id);
  if (!access.isLandlord) throw forbidden('Only the landlord decides an application.');

  if (input.outcome === 'declined' && !input.reason) {
    throw badRequest('A decline needs a reason. The applicant is told what it is.');
  }

  const updated = await withTransaction(async (run) => {
    const [application] = await run<{ id: string; status: string; unit_id: string }>(
      'select id, status, unit_id from application where id = $1 for update',
      [id],
    );
    if (!application) throw notFound('Application');
    if (!['submitted', 'screening'].includes(application.status)) {
      throw conflict(`This application is already ${application.status}.`);
    }

    await run(
      `update application
          set status = $2, decided_at = now(), decided_by = $3, decline_reason = $4, updated_at = now()
        where id = $1`,
      [id, input.outcome, person.sub, input.reason ?? null],
    );

    // Declining frees the unit again so it can be advertised without manual cleanup.
    if (input.outcome === 'declined') {
      await run("update unit set status = 'vacant' where id = $1 and status = 'held'", [
        application.unit_id,
      ]);
    }

    return { id, status: input.outcome };
  });

  await audit({
    actorSub: person.sub,
    actorRole: 'landlord',
    action: `application.${input.outcome}`,
    entity: 'application',
    entityId: id,
    detail: { reason: input.reason ?? null },
  });

  return json(200, updated);
});
