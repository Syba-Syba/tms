import { requireLeaseAccess } from '../lib/access';
import { ensureCase } from '../lib/arrears';
import { audit } from '../lib/audit';
import { query, withTransaction } from '../lib/db';
import { badRequest, conflict, forbidden, json, route } from '../lib/http';
import { leaseParties } from '../lib/lease-parties';
import { notify } from '../lib/notify';
import { renderLetterOfDemandPdf } from '../lib/pdf';
import { storage } from '../lib/storage';
import { daysBetween, LETTER_FROM_DAY, letterAllowed, REMEDY_BUSINESS_DAYS, remedyBy, type Step } from '../domain/arrears';
import { sastToday } from '../domain/dates';
import { zar } from '../domain/money';

/** A letter reads '28 October 2026', not an ISO date. */
const longDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const monthName = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-ZA', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/**
 * The landlord sends the letter of demand. It is a legal step, so the system never sends it on
 * its own: it renders the letter, files it on the lease, and emails the tenant. One per case.
 */
export const handler = route(async (event) => {
  const leaseId = event.pathParameters?.id;
  if (!leaseId) throw badRequest('A lease id is required.');
  const access = await requireLeaseAccess(event, leaseId);
  if (!access.isLandlord) throw forbidden('Only the landlord sends a letter of demand.');

  const today = sastToday();
  const invoices = await query<{ period_start: string; due_on: string; owed: string }>(
    `select i.period_start::text, i.due_on::text,
            i.total_cents - coalesce((select sum(p.amount_cents) from payment p where p.invoice_id = i.id), 0) as owed
       from invoice i
       join lease l on l.id = i.lease_id
      where i.lease_id = $1 and i.status in ('issued', 'part_paid') and i.due_on < $2::date
        and l.status in ('active', 'terminated')
      order by i.due_on`,
    [leaseId, today],
  );
  const owing = invoices.filter((row) => Number(row.owed) > 0);
  if (owing.length === 0) throw conflict('Nothing on this lease is overdue.');
  const daysLate = daysBetween(owing[0]!.due_on, today);
  if (daysLate < LETTER_FROM_DAY) {
    throw conflict(`A letter of demand can go from day ${LETTER_FROM_DAY}. This rent is ${daysLate} days late.`);
  }
  const totalCents = owing.reduce((sum, row) => sum + Number(row.owed), 0);
  const parties = await leaseParties(leaseId);
  if (!parties) throw badRequest('That lease no longer exists.');
  const deadline = remedyBy(today);

  const result = await withTransaction(async (run) => {
    const arrearsCase = await ensureCase(run, leaseId, today);
    // Lock the case so two clicks cannot both render and file a letter.
    await run('select id from arrears_case where id = $1 for update', [arrearsCase.id]);
    const taken = new Set<Step>(
      (await run<{ step: Step }>('select step from arrears_step where case_id = $1', [arrearsCase.id])).map((row) => row.step),
    );
    if (!letterAllowed(daysLate, taken)) throw conflict('A letter of demand has already gone for these arrears.');

    const rendered = await renderLetterOfDemandPdf({
      ref: parties.ref,
      dated: longDate(today),
      landlordName: parties.landlordName,
      landlordEmail: parties.landlordEmail,
      landlordPhone: parties.landlordPhone,
      tenantName: parties.tenantName,
      premises: parties.premises,
      leaseStart: longDate(parties.startDate),
      invoices: owing.map((row) => ({
        period: monthName(row.period_start),
        dueOn: longDate(row.due_on),
        outstandingCents: Number(row.owed),
      })),
      totalCents,
      remedyBy: longDate(deadline),
      remedyBusinessDays: REMEDY_BUSINESS_DAYS,
      paymentReference: parties.ref,
    });
    const key = `arrears/${leaseId}/${arrearsCase.id}/letter-of-demand.pdf`;
    await storage().put(key, rendered.bytes, 'application/pdf');

    const [step] = await run<{ id: string }>(
      `insert into arrears_step (case_id, step, taken_on, days_late, outstanding_cents, remedy_by, document_s3_key, taken_by)
       values ($1, 'letter_of_demand', $2, $3, $4, $5, $6, $7) returning id`,
      [arrearsCase.id, today, daysLate, totalCents, deadline, key, access.person.sub],
    );
    await notify(
      {
        leaseId,
        to: { sub: parties.tenantSub, email: parties.tenantEmail, phone: parties.tenantPhone },
        kind: 'letter_of_demand',
        dedupeKey: `letter_of_demand:${arrearsCase.id}`,
        data: { amount: zar(totalCents), unit: parties.unit, remedyBy: longDate(deadline), reference: parties.ref },
      },
      run,
    );
    return { stepId: step!.id, caseId: arrearsCase.id, key, sha256: rendered.sha256 };
  });

  await audit({
    actorSub: access.person.sub,
    actorRole: 'landlord',
    action: 'arrears.letter_sent',
    entity: 'lease',
    entityId: leaseId,
    detail: { caseId: result.caseId, outstandingCents: totalCents, remedyBy: deadline, sha256: result.sha256 },
  });

  return json(201, { key: result.key, remedyBy: deadline, outstandingCents: totalCents });
});
