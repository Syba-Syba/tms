import { caller } from '../lib/auth';
import { audit } from '../lib/audit';
import { withTransaction } from '../lib/db';
import { encryptIdNumber } from '../lib/idcrypt';
import { badRequest, conflict, json, notFound, parseBody, route } from '../lib/http';
import { createApplicationSchema } from '../domain/application';
import { isoDate, sastToday } from '../domain/dates';

export const handler = route(async (event) => {
  const person = caller(event);
  const input = parseBody(event, createApplicationSchema);

  if (isoDate(input.preferredMoveIn) < sastToday()) {
    throw badRequest('The move in date cannot be in the past.');
  }

  const encrypted = await encryptIdNumber(input.idNumber);
  // Notifications go to this address. The signed-in identity's email is the one the person
  // proved they can read; what they typed on the form is only a fallback.
  const email = (person.email || input.email).trim().toLowerCase();

  const result = await withTransaction(async (run) => {
    const [unit] = await run<{ id: string; status: string }>(
      'select id, status from unit where id = $1 for update',
      [input.unitId],
    );
    if (!unit) throw notFound('Unit');
    if (unit.status === 'occupied') throw conflict('That unit is already let.');

    const [applicant] = await run<{ id: string }>(
      `insert into applicant
         (cognito_sub, first_name, last_name, id_number_enc, id_number_last4, email, phone,
          employment_status, employer, monthly_income_cents)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (cognito_sub) do update set
         first_name = excluded.first_name,
         last_name = excluded.last_name,
         email = excluded.email,
         phone = excluded.phone,
         monthly_income_cents = excluded.monthly_income_cents
       returning id`,
      [
        person.sub || null,
        input.firstName,
        input.lastName,
        encrypted,
        input.idNumber.slice(-4),
        email,
        input.phone,
        input.employmentStatus,
        input.employer ?? null,
        input.monthlyIncomeCents,
      ],
    );

    // One open application per person per unit. A double tap, or applying again while the
    // first is still with the landlord, made a second row for the same decision. An approved
    // one counts too until its lease has ended or been cancelled: a second approval sent a
    // second notice and could never get a lease.
    const [open] = await run<{ id: string }>(
      `select a.id from application a
        where a.applicant_id = $1 and a.unit_id = $2
          and (a.status in ('draft', 'submitted', 'screening')
               or (a.status = 'approved' and not exists (
                     select 1 from lease l
                      where l.application_id = a.id and l.status in ('terminated', 'cancelled'))))
        limit 1`,
      [applicant!.id, input.unitId],
    );
    if (open) throw conflict('You already have an application open for this unit.');

    // A held unit with a lease being drawn up or signed is spoken for. Only one live lease
    // is allowed per unit, so approving this application would lead nowhere.
    const [leased] = await run<{ id: string }>(
      `select id from lease
        where unit_id = $1 and status in ('draft', 'out_for_signature', 'active')
        limit 1`,
      [input.unitId],
    );
    if (leased) throw conflict('That unit already has a lease in progress.');

    const [application] = await run<{ id: string; status: string }>(
      `insert into application
         (unit_id, applicant_id, status, occupants, preferred_move_in, pets, notes, submitted_at)
       values ($1, $2, 'submitted', $3, $4, $5, $6, now())
       returning id, status`,
      [
        input.unitId,
        applicant!.id,
        input.occupants,
        input.preferredMoveIn,
        input.pets,
        input.notes ?? null,
      ],
    );

    await run('update unit set status = $2 where id = $1 and status = $3', [
      input.unitId,
      'held',
      'vacant',
    ]);

    return application!;
  });

  await audit({
    actorSub: person.sub,
    actorRole: 'tenant',
    action: 'application.submitted',
    entity: 'application',
    entityId: result.id,
  });

  return json(201, { id: result.id, status: result.status });
});
