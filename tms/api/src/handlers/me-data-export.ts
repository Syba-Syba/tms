import { audit } from '../lib/audit';
import { caller } from '../lib/auth';
import { query } from '../lib/db';
import { json, route } from '../lib/http';

/**
 * POPIA section 23: a person may ask what is held about them. This answers in one file, for
 * whoever is signed in, with no landlord in the loop. Files are listed rather than embedded;
 * each opens from the app while signed in.
 *
 * The ID number is stored encrypted and nothing in the system decrypts it, so the export shows
 * its last four digits and says so.
 */
export const handler = route(async (event) => {
  const person = caller(event);
  const one = async <T>(sql: string, params: unknown[]) => (await query<T>(sql, params))[0] ?? null;

  const account = await one<Record<string, unknown>>(
    'select email, name, role, created_at from local_credential where sub = $1',
    [person.sub],
  );
  const applicant = await one<{ id: string } & Record<string, unknown>>(
    `select id, first_name, last_name, id_number_last4, email, phone, employment_status, employer,
            monthly_income_cents, created_at
       from applicant where cognito_sub = $1`,
    [person.sub],
  );
  const applicantId = applicant?.id ?? null;
  const byApplicant = (sql: string) => (applicantId ? query(sql, [applicantId]) : Promise.resolve([]));

  const exported = {
    exportedAt: new Date().toISOString(),
    note:
      'Everything this system holds about you. Your ID number is stored encrypted and is never ' +
      'decrypted, so only its last four digits appear here. Files are listed by name; open them ' +
      'from the app.',
    account,
    applicant: applicant
      ? { ...applicant, id: undefined, idNumber: applicant.id_number_last4 ? `ending ${String(applicant.id_number_last4)}` : null, id_number_last4: undefined }
      : null,
    applications: await byApplicant(
      `select a.id, p.name || ' ' || u.code as unit, a.status, a.occupants, a.preferred_move_in, a.pets,
              a.notes, a.submitted_at, a.decided_at, a.decline_reason
         from application a join unit u on u.id = a.unit_id join property p on p.id = u.property_id
        where a.applicant_id = $1 order by a.submitted_at`,
    ),
    applicationDocuments: await byApplicant(
      `select d.kind, d.content_type, d.size_bytes, d.uploaded_at from application_document d
         join application a on a.id = d.application_id where a.applicant_id = $1`,
    ),
    creditChecks: await byApplicant(
      `select c.bureau, c.checked_on, c.score, c.outcome, c.judgements, c.defaults, c.notes, c.recorded_at
         from credit_check c join application a on a.id = c.application_id where a.applicant_id = $1`,
    ),
    leases: await byApplicant(
      `select l.id, 'LSE-' || lpad(l.ref_no::text, 5, '0') as reference, p.name || ' ' || u.code as unit,
              l.start_date, l.end_date, l.monthly_rent_cents, l.deposit_cents, l.status
         from lease l join unit u on u.id = l.unit_id join property p on p.id = u.property_id
        where l.applicant_id = $1`,
    ),
    invoices: await byApplicant(
      `select i.period_start, i.due_on, i.total_cents, i.status from invoice i
         join lease l on l.id = i.lease_id where l.applicant_id = $1 order by i.period_start`,
    ),
    payments: await byApplicant(
      `select pay.amount_cents, pay.method, pay.reference, pay.received_on from payment pay
         join lease l on l.id = pay.lease_id where l.applicant_id = $1 order by pay.received_on`,
    ),
    depositLedger: await byApplicant(
      `select d.entry_type, d.amount_cents, d.occurred_on, d.note from deposit_ledger d
         join lease l on l.id = d.lease_id where l.applicant_id = $1 order by d.occurred_on`,
    ),
    proofsOfPayment: await byApplicant(
      `select pp.amount_cents, pp.paid_on, pp.reference, pp.status, pp.reject_reason, pp.submitted_at
         from payment_proof pp join lease l on l.id = pp.lease_id where l.applicant_id = $1`,
    ),
    // Every repair on their leases, not only the ones they reported, with what was said on each.
    maintenanceRequests: await byApplicant(
      `select t.title, t.description, t.category, t.severity, t.status, t.created_at, t.rating, t.rating_note
         from ticket t where t.lease_id in (select id from lease where applicant_id = $1) order by t.created_at`,
    ),
    maintenanceUpdates: await byApplicant(
      `select e.at, e.actor_role, e.kind, e.note from ticket_event e join ticket t on t.id = e.ticket_id
        where t.lease_id in (select id from lease where applicant_id = $1) order by e.at`,
    ),
    maintenancePhotos: await byApplicant(
      `select ph.phase, ph.content_type, ph.uploaded_at from ticket_photo ph join ticket t on t.id = ph.ticket_id
        where t.lease_id in (select id from lease where applicant_id = $1)`,
    ),
    inspections: await byApplicant(
      `select i.kind, i.status, i.scheduled_for, i.completed_at,
              (select json_agg(json_build_object('room', f.room, 'item', f.item, 'condition', f.condition, 'note', f.note))
                 from inspection_finding f where f.inspection_id = i.id) as findings
         from inspection i where i.lease_id in (select id from lease where applicant_id = $1) order by i.scheduled_for`,
    ),
    // Where and how they signed: the address and browser are recorded as evidence of signing.
    signatures: await byApplicant(
      `select 'lease' as document, signed_at, ip_address::text, user_agent from lease_signature
        where party = 'tenant' and lease_id in (select id from lease where applicant_id = $1)
       union all
       select 'inspection', s.signed_at, s.ip_address::text, s.user_agent from inspection_signature s
         join inspection i on i.id = s.inspection_id where s.party = 'tenant' and i.lease_id in (select id from lease where applicant_id = $1)
       order by signed_at`,
    ),
    endOfTenancy: await byApplicant(
      `select t.initiated_by, t.reason, t.notice_given_on, t.effective_on, t.penalty_cents, t.status, t.refund_rule,
              (select json_agg(json_build_object('description', d.description, 'amountCents', d.amount_cents))
                 from deposit_deduction d where d.termination_id = t.id) as deposit_deductions
         from termination t where t.lease_id in (select id from lease where applicant_id = $1)`,
    ),
    arrears: await byApplicant(
      `select c.opened_on, c.closed_on, c.paused_until, c.pause_reason,
              (select json_agg(json_build_object('step', st.step, 'takenOn', st.taken_on, 'outstandingCents', st.outstanding_cents) order by st.taken_on)
                 from arrears_step st where st.case_id = c.id) as steps
         from arrears_case c where c.lease_id in (select id from lease where applicant_id = $1)`,
    ),
    renewals: await byApplicant(
      `select offered_on, respond_by, term_months, new_start_date, new_end_date, new_rent_cents, escalation_pct, status, decided_at
         from renewal where lease_id in (select id from lease where applicant_id = $1)`,
    ),
    invitations: await byApplicant(
      `select email, created_at, expires_at, accepted_at, revoked_at from tenant_invite where applicant_id = $1`,
    ),
    messagesSentToYou: await query(
      `select channel, recipient_to, subject, body, status, created_at from notification where recipient_sub = $1
        order by created_at desc limit 500`,
      [person.sub],
    ),
    notificationPreferences: await query(
      'select category, channel, enabled from notification_preference where person_sub = $1',
      [person.sub],
    ),
    consents: await query(
      'select kind, version, accepted_at, ip_address, user_agent from consent where person_sub = $1 order by accepted_at',
      [person.sub],
    ),
    privacyRequests: await query(
      'select kind, status, note, response, created_at, decided_at from privacy_request where person_sub = $1',
      [person.sub],
    ),
    // What they did, and what others did to their records (a landlord viewing their ID copy).
    activity: await query(
      `select action, entity, at, actor_role from audit_log
        where actor_sub = $1
           or (entity = 'application' and entity_id in (select a.id from application a join applicant p on p.id = a.applicant_id where p.cognito_sub = $1))
           or (entity = 'lease' and entity_id in (select l.id from lease l join applicant p on p.id = l.applicant_id where p.cognito_sub = $1))
        order by at desc limit 2000`,
      [person.sub],
    ),
  };

  await audit({
    actorSub: person.sub,
    actorRole: person.groups.includes('landlord') ? 'landlord' : 'tenant',
    action: 'privacy.exported',
    entity: 'person',
    entityId: null,
  });
  return json(200, exported);
});
