import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { audit } from './audit';
import { query, withTransaction } from './db';
import { logger } from './logger';
import { storage } from './storage';
import { sastToday } from '../domain/dates';
import { erasureBlock, type LeaseForRetention } from '../domain/privacy';

type Run = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

/** Records what someone agreed to, with enough context to prove it later. */
export async function recordConsent(
  run: Run,
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  input: { sub: string; kind: 'privacy_notice' | 'application_screening' | 'terms_of_service' | 'credit_check'; version: string; subjectId?: string },
): Promise<void> {
  await run(
    `insert into consent (person_sub, kind, version, ip_address, user_agent, subject_id)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      input.sub,
      input.kind,
      input.version,
      event.requestContext.http?.sourceIp ?? null,
      (event.requestContext.http?.userAgent ?? '').slice(0, 300) || null,
      input.subjectId ?? null,
    ],
  );
}

/** Every lease a person has been the tenant on (with one landlord, or any), as the retention rule reads them. */
export async function leasesOf(sub: string, landlordId: string | null = null): Promise<LeaseForRetention[]> {
  const rows = await query<{ status: string; end_date: string; effective_on: string | null }>(
    `select l.status, l.end_date::text, t.effective_on::text
       from lease l
       join applicant a on a.id = l.applicant_id
       left join termination t on t.lease_id = l.id
       join unit u on u.id = l.unit_id
       join property p on p.id = u.property_id
      where a.cognito_sub = $1 and ($2::uuid is null or p.landlord_id = $2)`,
    [sub, landlordId],
  );
  return rows.map((row) => ({ status: row.status, endDate: row.end_date, terminationEffectiveOn: row.effective_on }));
}

export async function erasureBlockFor(sub: string, landlordId: string | null = null): Promise<string | null> {
  return erasureBlock(await leasesOf(sub, landlordId), sastToday());
}

/**
 * Erases what one landlord holds about a person, and the person's identity once no landlord
 * holds anything more about them.
 *
 * With `landlordId`, that landlord's records only, as the responsible party for them: uploaded
 * files and generated documents are deleted, free text the person wrote is blanked, payment
 * references and bank lines lose their name, and their name, email and phone are scrubbed from
 * that landlord's messages. The landlord's applications and leases then move onto an anonymous
 * stand-in record, so every screen of that landlord shows "Erased person" while rent, deposits
 * and leases still add up. Other landlords' records are not touched.
 *
 * Then, and also without `landlordId`, the identity goes once no application is left on the
 * person's own record: the applicant row, the sign-in, messages to them, the IP address and
 * device on their consents, and their email, name and IP addresses in the activity log. Someone
 * who still has records with another landlord (even one they never asked) keeps their account.
 *
 * Callers check the retention rule first. This does not, so a test can exercise it directly.
 */
export async function erasePerson(
  sub: string,
  actor: { sub: string; role: string },
  scope: { landlordId?: string } = {},
): Promise<{ files: number; identityErased: boolean }> {
  const landlordId = scope.landlordId ?? null;
  const { keys, identityErased } = await withTransaction(async (run) => {
    const [applicant] = await run<{ id: string; first_name: string; last_name: string; email: string; phone: string }>(
      'select id, first_name, last_name, email, phone from applicant where cognito_sub = $1 for update',
      [sub],
    );
    const [credential] = await run<{ email: string; name: string }>(
      'select email, name from local_credential where sub = $1',
      [sub],
    );
    const files: string[] = [];
    const collect = async (sql: string, params: unknown[]) => {
      const rows = await run<{ key: string | null }>(sql, params);
      for (const { key } of rows) {
        if (!key || key.startsWith('erased/')) continue;
        files.push(key);
        // A checked copy was made from a raw upload; the raw one is deleted too.
        const raw = key.replace(/\.kept\.([a-z]+)$/, '.$1');
        if (raw !== key) files.push(raw);
      }
    };

    if (applicant && landlordId) {
      const applications = (
        await run<{ id: string }>(
          `select ap.id from application ap join unit u on u.id = ap.unit_id join property p on p.id = u.property_id
            where ap.applicant_id = $1 and p.landlord_id = $2`,
          [applicant.id, landlordId],
        )
      ).map((row) => row.id);
      const leases = (
        await run<{ id: string }>(
          `select l.id from lease l join unit u on u.id = l.unit_id join property p on p.id = u.property_id
            where l.applicant_id = $1 and p.landlord_id = $2`,
          [applicant.id, landlordId],
        )
      ).map((row) => row.id);
      const apps = [applications];
      const ls = [leases];

      // Application paperwork and anything recorded about it.
      await collect('select s3_key as key from application_document where application_id = any($1)', apps);
      await run('delete from credit_check where application_id = any($1)', apps);
      await run('delete from application_document where application_id = any($1)', apps);
      await run('update application set notes = null where id = any($1)', apps);

      // Files on the leases: slips, the lease and invoice PDFs, signatures, inspection reports,
      // the deposit statement, letters of demand, and the photos they took reporting repairs.
      await collect('select s3_key as key from payment_proof where lease_id = any($1)', ls);
      await collect('select pdf_s3_key as key from lease where id = any($1)', ls);
      await collect('select pdf_s3_key as key from invoice where lease_id = any($1)', ls);
      await collect(`select signature_s3_key as key from lease_signature where party = 'tenant' and lease_id = any($1)`, ls);
      await collect(
        `select s.signature_s3_key as key from inspection_signature s join inspection i on i.id = s.inspection_id
          where s.party = 'tenant' and i.lease_id = any($1)`,
        ls,
      );
      await collect('select pdf_s3_key as key from inspection where lease_id = any($1)', ls);
      await collect('select draft_s3_key as key from inspection where lease_id = any($1)', ls);
      await collect('select statement_s3_key as key from termination where lease_id = any($1)', ls);
      await collect(
        `select st.document_s3_key as key from arrears_step st join arrears_case c on c.id = st.case_id
          where c.lease_id = any($1)`,
        ls,
      );
      await collect(
        `select ph.s3_key as key from ticket_photo ph join ticket t on t.id = ph.ticket_id
          where ph.phase = 'report' and t.created_by = $2 and t.lease_id = any($1)`,
        [leases, sub],
      );

      // Required keys point at nothing rather than being cleared.
      await run(`update payment_proof set s3_key = 'erased/' || id, reference = null where lease_id = any($1)`, ls);
      await run('update lease set pdf_s3_key = null where id = any($1)', ls);
      await run('update invoice set pdf_s3_key = null where lease_id = any($1)', ls);
      await run(
        `update lease_signature set signature_s3_key = 'erased/' || id, ip_address = null, user_agent = null
          where party = 'tenant' and lease_id = any($1)`,
        ls,
      );
      await run(
        `update inspection_signature set signature_s3_key = 'erased/' || id, ip_address = null, user_agent = null
          where party = 'tenant' and inspection_id in (select id from inspection where lease_id = any($1))`,
        ls,
      );
      await run('update inspection set pdf_s3_key = null, draft_s3_key = null where lease_id = any($1)', ls);
      await run('update termination set statement_s3_key = null where lease_id = any($1)', ls);
      await run(
        `update arrears_step set document_s3_key = 'erased/' || id
          where document_s3_key is not null and case_id in (select id from arrears_case where lease_id = any($1))`,
        ls,
      );
      // What the tenant wrote about repairs, and the photos they took reporting them. The ticket
      // and the completion photos stay: they are the property's maintenance history.
      await run(
        `delete from ticket_photo where phase = 'report'
            and ticket_id in (select id from ticket where created_by = $2 and lease_id = any($1))`,
        [leases, sub],
      );
      await run(
        `update ticket set description = '[Removed at the tenant''s request]', rating_note = null
          where created_by = $2 and lease_id = any($1)`,
        [leases, sub],
      );
      await run(
        `update ticket_event set note = '[Removed at the tenant''s request]'
          where actor_role = 'tenant' and note is not null and ticket_id in (select id from ticket where lease_id = any($1))`,
        ls,
      );
      // Payment references and bank lines carry their name ("N PHIRI LSE-00101").
      await run('update payment set reference = null where lease_id = any($1)', ls);
      await run(`update bank_line set description = '[erased]' where lease_id = any($1)`, ls);
      await run('delete from tenant_invite where lease_id = any($1)', ls);

      // The landlord's own messages about this person ("Proof of payment from Naledi Phiri,
      // call 082…") keep their purpose but lose the details.
      const fullName = `${applicant.first_name} ${applicant.last_name}`.trim();
      // A blank phone must not match (and blank out) every message. The number is stored as
      // +27…, and messages often carry it as dialled locally, 08….
      const phone = applicant.phone || 'no phone on record';
      const localPhone = phone.startsWith('+27') ? `0${phone.slice(3)}` : phone;
      const scrub = (column: string) =>
        `replace(replace(replace(replace(${column}, $2, 'the tenant'), $3, '[email removed]'), $4, '[phone removed]'), $5, '[phone removed]')`;
      await run(
        `update notification set subject = ${scrub('subject')}, body = ${scrub('body')}
          where lease_id = any($1) and recipient_sub is distinct from $6`,
        [leases, fullName, applicant.email, phone, localPhone, sub],
      );

      // The landlord's applications and leases move to an anonymous stand-in, so the shared
      // record no longer shows this landlord the person's name, contact details or income.
      if (applications.length > 0 || leases.length > 0) {
        const [standIn] = await run<{ id: string }>(
          `insert into applicant (first_name, last_name, email, phone, monthly_income_cents, erased_at)
           values ('Erased', 'person', 'erased-' || gen_random_uuid() || '@invalid', '', 0, now())
           returning id`,
        );
        await run('update lease set applicant_id = $2 where id = any($1)', [leases, standIn!.id]);
        await run('update application set applicant_id = $2 where id = any($1)', [applications, standIn!.id]);
      }
    }

    // The identity goes once no landlord holds an application about this person any more.
    // Every lease hangs off an application, so this covers leases too.
    const [left] = applicant
      ? await run<{ n: number }>('select count(*)::int as n from application where applicant_id = $1', [applicant.id])
      : [{ n: 0 }];
    if (left!.n > 0) return { keys: files, identityErased: false };

    const emails = [...new Set([applicant?.email, credential?.email].filter((e): e is string => Boolean(e)))];
    const names = [...new Set([applicant ? `${applicant.first_name} ${applicant.last_name}`.trim() : null, credential?.name]
      .filter((n): n is string => Boolean(n && n.length >= 3)))];
    // Their email, name and the IP addresses of their sign-ins in the activity log. Failed
    // sign-ins for their email carry no actor, so they are found by the email in the detail.
    for (const email of emails) {
      await run(
        `update audit_log set detail = (replace(detail::text, $1, '[email removed]'))::jsonb - 'address'
          where detail::text like '%' || $1 || '%'`,
        [email],
      );
    }
    for (const name of names) {
      await run(
        `update audit_log set detail = (replace(detail::text, $1, 'the tenant'))::jsonb where detail::text like '%' || $1 || '%'`,
        [name],
      );
    }
    await run(`update audit_log set detail = detail - 'address' where actor_sub = $1 and detail ? 'address'`, [sub]);
    // What they agreed to, and when, stays as proof; where from and on what device does not.
    await run('update consent set ip_address = null, user_agent = null where person_sub = $1', [sub]);
    if (applicant) {
      await run(
        `update applicant set first_name = 'Erased', last_name = 'person', id_number_enc = '\\x00',
                id_number_last4 = '0000', email = 'erased-' || id || '@invalid', phone = '',
                employer = null, monthly_income_cents = 0, cognito_sub = null, erased_at = now()
          where id = $1`,
        [applicant.id],
      );
      await run('delete from tenant_invite where applicant_id = $1', [applicant.id]);
    }
    await run('delete from tenant_invite where accepted_sub = $1', [sub]);
    await run('delete from notification where recipient_sub = $1', [sub]);
    await run('delete from notification_preference where person_sub = $1', [sub]);
    // Password reset links and recovery codes go with the sign-in (on delete cascade).
    await run('delete from local_credential where sub = $1', [sub]);
    return { keys: files, identityErased: true };
  });

  // After the commit: a file that fails to delete is logged and retried by hand, never a reason
  // to leave the person's details in the database.
  for (const key of keys) {
    await storage()
      .remove(key)
      .catch((error) => logger.error('Erasure could not delete a file.', { key, error }));
  }

  await audit({
    actorSub: actor.sub,
    actorRole: actor.role,
    action: 'privacy.erased',
    entity: 'person',
    entityId: null,
    detail: { personSub: sub, files: keys.length, landlordId, identityErased },
  });
  return { files: keys.length, identityErased };
}

/** A message straight to an address, outside preferences: the person asked for this answer. */
export async function tellPerson(run: Run | null, sub: string, email: string, subject: string, body: string) {
  const execute: Run = run ?? ((sql, params) => query(sql, params) as Promise<never[]>);
  await execute(
    `insert into notification (recipient_sub, recipient_to, channel, category, kind, urgent, subject, body)
     values ($1, $2, 'email', 'account', 'privacy_request', false, $3, $4)`,
    [sub, email, subject, body],
  );
}
