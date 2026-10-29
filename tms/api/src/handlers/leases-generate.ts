import { requireApplicationAccess } from '../lib/access';
import { requireLandlord } from '../lib/auth';
import { audit } from '../lib/audit';
import { withTransaction } from '../lib/db';
import { badRequest, conflict, forbidden, json, notFound, parseBody, route } from '../lib/http';
import { generateLeaseSchema, leaseEndDate } from '../domain/lease';

export const handler = route(async (event) => {
  const person = requireLandlord(event);
  const applicationId = event.pathParameters?.id;
  if (!applicationId) throw badRequest('An application id is required.');
  const input = parseBody(event, generateLeaseSchema);

  // A lease binds this landlord's unit, so only that landlord may raise it.
  const access = await requireApplicationAccess(event, applicationId);
  if (!access.isLandlord) throw forbidden('Only the landlord generates the lease.');

  const lease = await withTransaction(async (run) => {
    const [application] = await run<{
      id: string;
      status: string;
      unit_id: string;
      applicant_id: string;
      monthly_rent_cents: string;
      deposit_cents: string;
    }>(
      `select a.id, a.status, a.unit_id, a.applicant_id, u.monthly_rent_cents, u.deposit_cents
         from application a join unit u on u.id = a.unit_id
        where a.id = $1 for update`,
      [applicationId],
    );
    if (!application) throw notFound('Application');
    if (application.status !== 'approved') {
      throw conflict('Approve the application before generating a lease.');
    }

    const [existing] = await run<{ id: string }>(
      "select id from lease where application_id = $1 and status <> 'cancelled'",
      [applicationId],
    );
    if (existing) throw conflict('A lease already exists for this application.');

    let created: { id: string; start_date: string; end_date: string } | undefined;
    try {
      [created] = await run<{ id: string; start_date: string; end_date: string }>(
        `insert into lease
           (application_id, unit_id, applicant_id, start_date, end_date,
            monthly_rent_cents, escalation_pct, deposit_cents, status)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'out_for_signature')
         returning id, start_date, end_date`,
        [
          applicationId,
          application.unit_id,
          application.applicant_id,
          input.startDate,
          leaseEndDate(input.startDate, input.months ?? 12),
          Number(application.monthly_rent_cents),
          input.escalationPct,
          input.depositCents ?? Number(application.deposit_cents),
        ],
      );
    } catch (error) {
      // lease_one_live_per_unit: another applicant's lease for this unit is out for signature
      // or running. This surfaced as a 500.
      if ((error as { code?: string }).code === '23505') {
        throw conflict(
          'This unit already has a lease out for signature or running. Cancel that lease before generating another.',
        );
      }
      throw error;
    }

    return created!;
  });

  await audit({
    actorSub: person.sub,
    actorRole: 'landlord',
    action: 'lease.generated',
    entity: 'lease',
    entityId: lease.id,
    detail: { applicationId, months: input.months },
  });

  // The PDF is rendered by a follow-on worker so a slow render cannot time out this request.
  return json(201, {
    id: lease.id,
    startDate: lease.start_date,
    endDate: lease.end_date,
    status: 'out_for_signature',
  });
});
