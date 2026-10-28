import { requireApplicationAccess } from '../lib/access';
import { requireLandlord } from '../lib/auth';
import { audit } from '../lib/audit';
import { withTransaction } from '../lib/db';
import { badRequest, conflict, forbidden, json, notFound, parseBody, route } from '../lib/http';
import { decisionSchema } from '../domain/application';
import { logger } from '../lib/logger';
import { notify } from '../lib/notify';

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
    const [application] = await run<{
      id: string;
      status: string;
      unit_id: string;
      applicant_sub: string | null;
      applicant_email: string | null;
      applicant_phone: string | null;
      unit_label: string;
    }>(
      `select a.id, a.status, a.unit_id, ap.cognito_sub as applicant_sub, ap.email as applicant_email,
              ap.phone as applicant_phone, p.name || ' ' || u.code as unit_label
         from application a
         join applicant ap on ap.id = a.applicant_id
         join unit u on u.id = a.unit_id
         join property p on p.id = u.property_id
        where a.id = $1
        for update of a`,
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

    return {
      result: { id, status: input.outcome },
      to: application.applicant_sub
        ? { sub: application.applicant_sub, email: application.applicant_email, phone: application.applicant_phone }
        : null,
      unit: application.unit_label,
    };
  });

  await audit({
    actorSub: person.sub,
    actorRole: 'landlord',
    action: `application.${input.outcome}`,
    entity: 'application',
    entityId: id,
    detail: { reason: input.reason ?? null },
  });

  // The applicant used to hear nothing either way, and found out only by opening the app.
  if (updated.to) {
    try {
      await notify({
        to: updated.to,
        kind: input.outcome === 'approved' ? 'application_approved' : 'application_declined',
        dedupeKey: `application_decided:${id}`,
        data: { unit: updated.unit, reason: input.reason ?? '' },
      });
    } catch (error) {
      logger.error('Application decision notification failed.', { applicationId: id, error });
    }
  }

  return json(200, updated.result);
});
