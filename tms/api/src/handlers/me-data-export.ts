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
  // Long lists are cut, and the export says so rather than passing a part off as the whole.
  const truncated: Record<string, boolean> = {};
  const capped = async (name: string, limit: number, sql: string, params: unknown[]) => {
    const rows = await query(`${sql} limit ${limit + 1}`, params);
    truncated[name] = rows.length > limit;
    return rows.slice(0, limit);
  };
  const theirLeases = 'select id from lease where applicant_id = $1';
  const ref = `'LSE-' || lpad(l.ref_no::text, 5, '0')`;

  const exported = {
    exportedAt: new Date().toISOString(),
    note:
      'What this system holds about you. Your ID number is stored encrypted and is never ' +
      'decrypted, so only its last four digits appear here. Files are listed by kind and date ' +
      '(documents, applicationDocuments, maintenancePhotos); open them from the app. Where ' +
      '"truncated" says a list was cut, ask your landlord or the operator for the rest.',
    account,
    applicant: applicant
      ? { ...applicant, id: undefined, idNumber: applicant.id_number_last4 ? `ending ${String(applicant.id_number_last4)}` : null, id_number_last4: undefined }
      : null,
    // Names this record has carried (a new surname given with a later application).
    namesUsed: await byApplicant('select first_name, last_name, first_seen from applicant_name where applicant_id = $1 order by first_seen'),
    applications: await byApplicant(
      `select a.id, p.name || ' ' || u.code as unit, a.status, a.occupants, a.preferred_move_in, a.pets,
              a.notes, a.monthly_income_cents, a.employment_status, a.employer,
              a.submitted_at, a.decided_at, a.decline_reason
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
    invoiceLines: await byApplicant(
      `select i.period_start, il.kind, il.description, il.amount_cents from invoice_line il
         join invoice i on i.id = il.invoice_id where i.lease_id in (${theirLeases}) order by i.period_start`,
    ),
    // Charges added to a lease that wait for the next invoice.
    pendingCharges: await byApplicant(
      `select period_start, kind, description, amount_cents, created_at from pending_charge
        where lease_id in (${theirLeases}) order by period_start`,
    ),
    // The landlord's bank statement lines matched to their leases: the description is what their
    // bank sent ("N PHIRI RENT").
    bankLines: await byApplicant(
      `select b.posted_on, b.amount_cents, b.description from bank_line b
        where b.status = 'matched' and b.lease_id in (${theirLeases}) order by b.posted_on`,
    ),
    // Every file kept about them on their leases, by kind and date. "available" is false once a
    // file has been erased.
    documents: await byApplicant(
      `select * from (
         select 'lease' as document, ${ref} as lease, l.start_date::text as dated, true as available
           from lease l where l.applicant_id = $1 and l.pdf_s3_key is not null
         union all
         select 'invoice', ${ref}, i.period_start::text, true from invoice i join lease l on l.id = i.lease_id
          where l.applicant_id = $1 and i.pdf_s3_key is not null
         union all
         select 'inspection report', ${ref}, coalesce(i.completed_at::date, i.scheduled_for::date)::text, true
           from inspection i join lease l on l.id = i.lease_id where l.applicant_id = $1 and i.pdf_s3_key is not null
         union all
         select 'deposit statement', ${ref}, t.effective_on::text, true from termination t join lease l on l.id = t.lease_id
          where l.applicant_id = $1 and t.statement_s3_key is not null
         union all
         select 'arrears ' || st.step, ${ref}, st.taken_on::text, st.document_s3_key not like 'erased/%'
           from arrears_step st join arrears_case c on c.id = st.case_id join lease l on l.id = c.lease_id
          where l.applicant_id = $1 and st.document_s3_key is not null
         union all
         select 'proof of payment', ${ref}, pp.submitted_at::date::text, pp.s3_key not like 'erased/%'
           from payment_proof pp join lease l on l.id = pp.lease_id where l.applicant_id = $1
       ) d order by dated`,
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
    messagesSentToYou: await capped(
      'messagesSentToYou',
      500,
      // A reset or invite link in a message is a live credential: shown here, a stolen session
      // could use it to set a new password. The text stays, the token does not.
      // Messages from before they had an account went to a stand-in address: 'applicant:<id>'
      // for an imported tenant, 'tenant-invite:<id>' for the invite. Those count too, and so
      // does anything on their leases sent to their email or phone (an imported row that was
      // merged into theirs on claiming leaves no applicant id to match).
      `select channel, recipient_to, subject,
              regexp_replace(body, '([?&](token|sig)=)[^[:space:]&]+', '\\1[removed]', 'g') as body,
              status, created_at from notification n
        where n.recipient_sub = $1
           or ($2::uuid is not null and n.recipient_sub = 'applicant:' || $2::uuid)
           or n.recipient_sub in (select 'tenant-invite:' || ti.id from tenant_invite ti where ti.accepted_sub = $1)
           or (n.lease_id in (select l.id from lease l join applicant p on p.id = l.applicant_id where p.cognito_sub = $1)
               and (lower(n.recipient_to) = any($3::text[]) or n.recipient_to = $4))
        order by created_at desc`,
      [
        person.sub,
        applicantId,
        [account?.email, applicant?.email].filter((e): e is string => typeof e === 'string' && e.length > 0).map((e) => e.toLowerCase()),
        typeof applicant?.phone === 'string' && applicant.phone ? applicant.phone : null,
      ],
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
    activity: await capped(
      'activity',
      2000,
      `select action, entity, at, actor_role from audit_log
        where actor_sub = $1
           or (entity = 'application' and entity_id in (select a.id from application a join applicant p on p.id = a.applicant_id where p.cognito_sub = $1))
           or (entity = 'lease' and entity_id in (select l.id from lease l join applicant p on p.id = l.applicant_id where p.cognito_sub = $1))
        order by at desc`,
      [person.sub],
    ),
    truncated,
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
