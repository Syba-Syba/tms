import { requireApplicationAccess } from '../lib/access';
import { audit } from '../lib/audit';
import { withTransaction } from '../lib/db';
import { badRequest, conflict, json, notFound, route } from '../lib/http';
import { notify } from '../lib/notify';
import { releaseUnitIfUnclaimed } from './applications-decide';

/**
 * There was no way out of an application. One never decided, or approved but never given a
 * lease, held the unit for good. The applicant may withdraw until a lease goes out for
 * signature. The landlord may withdraw an approved one whose lease was never signed, for the
 * applicant who went silent; one still waiting on a decision is declined instead, with a reason.
 */
export const handler = route(async (event) => {
  const id = event.pathParameters?.id;
  if (!id) throw badRequest('An application id is required.');
  const access = await requireApplicationAccess(event, id);
  const person = access.person;
  // Someone who is both (a landlord applying to their own unit) is treated as the applicant.
  const asLandlord = access.isLandlord && !access.isApplicant;

  await withTransaction(async (run) => {
    const [application] = await run<{ id: string; status: string; unit_id: string }>(
      'select id, status, unit_id from application where id = $1 for update',
      [id],
    );
    if (!application) throw notFound('Application');

    const allowed = asLandlord ? ['approved'] : ['submitted', 'screening', 'approved'];
    if (!allowed.includes(application.status)) {
      throw conflict(
        asLandlord && ['submitted', 'screening'].includes(application.status)
          ? 'This application is still waiting on a decision. Decline it instead.'
          : `This application is already ${application.status}.`,
      );
    }

    const leases = await run<{ id: string; status: string }>(
      "select id, status from lease where application_id = $1 and status <> 'cancelled' for update",
      [id],
    );
    const cancellable = asLandlord ? ['draft', 'out_for_signature'] : ['draft'];
    if (leases.some((lease) => !cancellable.includes(lease.status))) {
      throw conflict(
        asLandlord
          ? 'This application has a signed lease. End the lease instead.'
          : 'Your lease has already been sent for signing. Ask the landlord to withdraw the application.',
      );
    }

    await run(
      `update application set status = 'withdrawn', decided_at = now(), updated_at = now()
        where id = $1`,
      [id],
    );
    const ids = leases.map((lease) => lease.id);
    // Cancelled before the unit check, which would otherwise count this lease as a claim on it.
    await run(
      "update lease set status = 'cancelled' where application_id = $1 and status in ('draft', 'out_for_signature')",
      [id],
    );
    await releaseUnitIfUnclaimed(run, application.unit_id, id);

    // An inspection booked on a lease that will never start is not going to happen. Left open,
    // the morning sweep kept reminding both parties of it. 'missed' is the only closed state
    // short of a completed, signed inspection.
    if (ids.length > 0) {
      await run(
        `update inspection set status = 'missed'
          where lease_id = any($1::uuid[]) and status in ('in_progress', 'awaiting_signatures')`,
        [ids],
      );
    }

    // The applicant may already have signed the lease that has just been cancelled, and heard
    // nothing. Sent in the same commit, so they are told only if the withdrawal stands. One
    // without an account is addressed by their applicant row, so the email still reaches them.
    if (asLandlord) {
      const [applicant] = await run<{ sub: string; email: string; phone: string; unit: string }>(
        `select coalesce(ap.cognito_sub, 'applicant:' || ap.id) as sub, ap.email, ap.phone,
                p.name || ' ' || u.code as unit
           from application a
           join applicant ap on ap.id = a.applicant_id
           join unit u on u.id = a.unit_id
           join property p on p.id = u.property_id
          where a.id = $1`,
        [id],
      );
      if (applicant) {
        await notify(
          {
            to: { sub: applicant.sub, email: applicant.email, phone: applicant.phone },
            kind: 'application_withdrawn',
            dedupeKey: `application_withdrawn:${id}`,
            data: { unit: applicant.unit },
          },
          run,
        );
      }
    }

    await audit(
      {
        actorSub: person.sub,
        actorRole: asLandlord ? 'landlord' : 'tenant',
        action: 'application.withdrawn',
        entity: 'application',
        entityId: id,
        detail: { previousStatus: application.status, cancelledLeases: ids },
      },
      run,
    );
  });

  return json(200, { id, status: 'withdrawn' });
});
