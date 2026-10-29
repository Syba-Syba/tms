import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { audit } from './audit';
import { query, withTransaction } from './db';
import { logger } from './logger';
import { storage } from './storage';
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
  return erasureBlock(await leasesOf(sub, landlordId), new Date().toISOString().slice(0, 10));
}

/**
 * Erases a person's personal information, from one landlord's records or from all of them.
 *
 * Rows that rent, deposits and leases hang off stay, with the person's details removed, so a
 * landlord's books still add up. Uploaded files are deleted, free text the person wrote is
 * blanked, and their name, email and phone are scrubbed from the landlord's notifications.
 *
 * `landlordId` scopes it to one landlord, who answered the request as responsible party for
 * their own records only. The person's identity (the applicant row, the sign-in, messages to
 * them, their name in the activity log) goes only with `identity: true`: once every landlord
 * concerned has erased, or when there was never a landlord at all.
 *
 * Callers check the retention rule first. This does not, so a test can exercise it directly.
 */
export async function erasePerson(
  sub: string,
  actor: { sub: string; role: string },
  scope: { landlordId?: string | null; identity?: boolean } = {},
): Promise<{ files: number }> {
  const landlordId = scope.landlordId ?? null;
  const identity = scope.identity ?? landlordId === null;
  const keys = await withTransaction(async (run) => {
    const [applicant] = await run<{ id: string; first_name: string; last_name: string; email: string; phone: string }>(
      'select id, first_name, last_name, email, phone from applicant where cognito_sub = $1 for update',
      [sub],
    );
    const files: string[] = [];

    if (applicant) {
      // Applications and leases in scope: one landlord's, or every one.
      const inScope = `(select ap.id from application ap join unit u on u.id = ap.unit_id join property p on p.id = u.property_id
                         where ap.applicant_id = $1 and ($2::uuid is null or p.landlord_id = $2))`;
      const leasesInScope = `(select l.id from lease l join unit u on u.id = l.unit_id join property p on p.id = u.property_id
                               where l.applicant_id = $1 and ($2::uuid is null or p.landlord_id = $2))`;
      const ids = [applicant.id, landlordId];
      const collect = async (sql: string, params: unknown[] = ids) => {
        const rows = await run<{ key: string | null }>(sql, params);
        files.push(...rows.map((row) => row.key).filter((key): key is string => Boolean(key) && !key!.startsWith('erased/')));
      };

      // Application paperwork and anything recorded about it.
      await collect(`select s3_key as key from application_document where application_id in ${inScope}`);
      await run(`delete from credit_check where application_id in ${inScope}`, ids);
      await run(`delete from application_document where application_id in ${inScope}`, ids);
      await run(`update application set notes = null where id in ${inScope}`, ids);

      // Files on the leases: slips, the lease and invoice PDFs, signatures, repair photos.
      await collect(`select s3_key as key from payment_proof where lease_id in ${leasesInScope}`);
      await collect(`select pdf_s3_key as key from lease where id in ${leasesInScope}`);
      await collect(`select pdf_s3_key as key from invoice where lease_id in ${leasesInScope}`);
      await collect(`select signature_s3_key as key from lease_signature where party = 'tenant' and lease_id in ${leasesInScope}`);
      await collect(`select s.signature_s3_key as key from inspection_signature s join inspection i on i.id = s.inspection_id
                      where s.party = 'tenant' and i.lease_id in ${leasesInScope}`);
      await collect(
        `select ph.s3_key as key from ticket_photo ph join ticket t on t.id = ph.ticket_id
          where ph.phase = 'report' and t.created_by = $3 and t.lease_id in ${leasesInScope}`,
        [...ids, sub],
      );

      // The keys are required, so they point at nothing rather than being cleared.
      await run(`update payment_proof set s3_key = 'erased/' || id, reference = null where lease_id in ${leasesInScope}`, ids);
      await run(`update lease set pdf_s3_key = null where id in ${leasesInScope}`, ids);
      await run(`update invoice set pdf_s3_key = null where lease_id in ${leasesInScope}`, ids);
      await run(
        `update lease_signature set signature_s3_key = 'erased/' || id, ip_address = null, user_agent = null
          where party = 'tenant' and lease_id in ${leasesInScope}`,
        ids,
      );
      await run(
        `update inspection_signature set signature_s3_key = 'erased/' || id, ip_address = null, user_agent = null
          where party = 'tenant' and inspection_id in (select id from inspection where lease_id in ${leasesInScope})`,
        ids,
      );
      // What the tenant wrote about repairs, and the photos they took when reporting. The ticket and the completion photos stay: it is
      // the property's maintenance history.
      await run(
        `delete from ticket_photo where phase = 'report' and ticket_id in (select id from ticket where created_by = $3 and lease_id in ${leasesInScope})`,
        [...ids, sub],
      );
      await run(
        `update ticket set description = '[Removed at the tenant''s request]', rating_note = null
          where created_by = $3 and lease_id in ${leasesInScope}`,
        [...ids, sub],
      );
      await run(
        `update ticket_event set note = '[Removed at the tenant''s request]'
          where actor_role = 'tenant' and note is not null and ticket_id in (select id from ticket where lease_id in ${leasesInScope})`,
        ids,
      );
      // Payment references and bank lines carry their name ("N PHIRI LSE-00101").
      await run(`update payment set reference = null where lease_id in ${leasesInScope}`, ids);
      await run(`update bank_line set description = '[erased]' where lease_id in ${leasesInScope}`, ids);
      await run(`delete from tenant_invite where lease_id in ${leasesInScope} or (applicant_id = $1 and $2::uuid is null)`, ids);

      // The landlord's own messages about this person ("Proof of payment from Naledi Phiri,
      // call 082…") keep their purpose but lose the details.
      const fullName = `${applicant.first_name} ${applicant.last_name}`.trim();
      const scrub = (column: string) =>
        `replace(replace(replace(replace(${column}, $3, 'the tenant'), $4, '[email removed]'), $5, '[phone removed]'), $7, '[phone removed]')`;
      // A blank phone must not match (and blank out) every message. The number is stored as
      // +27…, and messages often carry it as dialled locally, 08….
      const phone = applicant.phone || 'no phone on record';
      const localPhone = phone.startsWith('+27') ? `0${phone.slice(3)}` : phone;
      const identifiers = [fullName, applicant.email, phone];
      await run(
        `update notification set subject = ${scrub('subject')}, body = ${scrub('body')}
          where recipient_sub is distinct from $6
            and (lease_id in ${leasesInScope} or ($2::uuid is null and (body like '%' || $3 || '%' or subject like '%' || $3 || '%')))`,
        [...ids, ...identifiers, sub, localPhone],
      );

      if (identity) {
        // Their name and email in the activity log (sign-ins, invites, password resets).
        await run(
          `update audit_log set detail = replace(replace(detail::text, $1, '[email removed]'), $2, 'the tenant')::jsonb
            where detail::text like '%' || $1 || '%' or detail::text like '%' || $2 || '%'`,
          [applicant.email, fullName],
        );
        await run(
          `update applicant set first_name = 'Erased', last_name = 'person', id_number_enc = '\\x00',
                  id_number_last4 = '0000', email = 'erased-' || id || '@invalid', phone = '',
                  employer = null, monthly_income_cents = 0, cognito_sub = null, erased_at = now()
            where id = $1`,
          [applicant.id],
        );
      }
    }

    if (identity) {
      await run('delete from notification where recipient_sub = $1', [sub]);
      await run('delete from notification_preference where person_sub = $1', [sub]);
      await run('delete from local_credential where sub = $1', [sub]);
    }
    return files;
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
    detail: { personSub: sub, files: keys.length, landlordId, identity },
  });
  return { files: keys.length };
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
