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
  input: { sub: string; kind: 'privacy_notice' | 'application_screening' | 'terms_of_service'; version: string; subjectId?: string },
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

/** Every lease a person has been the tenant on, in the shape the retention rule reads. */
export async function leasesOf(sub: string): Promise<LeaseForRetention[]> {
  const rows = await query<{ status: string; end_date: string; effective_on: string | null }>(
    `select l.status, l.end_date::text, t.effective_on::text
       from lease l
       join applicant a on a.id = l.applicant_id
       left join termination t on t.lease_id = l.id
      where a.cognito_sub = $1`,
    [sub],
  );
  return rows.map((row) => ({ status: row.status, endDate: row.end_date, terminationEffectiveOn: row.effective_on }));
}

export async function erasureBlockFor(sub: string): Promise<string | null> {
  return erasureBlock(await leasesOf(sub), new Date().toISOString().slice(0, 10));
}

/**
 * Erases a person. Rows that rent, deposits and leases hang off stay, with the person's details
 * replaced, so a landlord's books still add up. Their uploaded files are deleted, their sign-in
 * is removed (which ends every session), and the messages addressed to them are gone.
 *
 * Callers check the retention rule first. This does not, so a test can exercise it directly.
 */
export async function erasePerson(sub: string, actor: { sub: string; role: string }): Promise<{ files: number }> {
  const keys = await withTransaction(async (run) => {
    const [applicant] = await run<{ id: string }>('select id from applicant where cognito_sub = $1 for update', [sub]);
    const files: string[] = [];

    if (applicant) {
      const documents = await run<{ s3_key: string }>(
        `select d.s3_key from application_document d join application a on a.id = d.application_id
          where a.applicant_id = $1`,
        [applicant.id],
      );
      const slips = await run<{ id: string; s3_key: string }>(
        `select pp.id, pp.s3_key from payment_proof pp join lease l on l.id = pp.lease_id
          where l.applicant_id = $1 and pp.s3_key not like 'erased/%'`,
        [applicant.id],
      );
      const leaseFiles = await run<{ pdf_s3_key: string | null }>(
        'select pdf_s3_key from lease where applicant_id = $1 and pdf_s3_key is not null',
        [applicant.id],
      );
      const signatures = await run<{ id: string; signature_s3_key: string }>(
        `select s.id, s.signature_s3_key from lease_signature s join lease l on l.id = s.lease_id
          where l.applicant_id = $1 and s.party = 'tenant' and s.signature_s3_key not like 'erased/%'`,
        [applicant.id],
      );
      files.push(
        ...documents.map((row) => row.s3_key),
        ...slips.map((row) => row.s3_key),
        ...leaseFiles.map((row) => row.pdf_s3_key!),
        ...signatures.map((row) => row.signature_s3_key),
      );

      await run(
        `delete from application_document where application_id in
           (select id from application where applicant_id = $1)`,
        [applicant.id],
      );
      await run(`update application set notes = null where applicant_id = $1`, [applicant.id]);
      // The keys are unique and required, so they point at nothing rather than being cleared.
      await run(
        `update payment_proof set s3_key = 'erased/' || id, reference = null
          where lease_id in (select id from lease where applicant_id = $1)`,
        [applicant.id],
      );
      await run('update lease set pdf_s3_key = null where applicant_id = $1', [applicant.id]);
      await run(
        `update lease_signature set signature_s3_key = 'erased/' || id
          where party = 'tenant' and lease_id in (select id from lease where applicant_id = $1)`,
        [applicant.id],
      );
      await run(
        `update applicant set first_name = 'Erased', last_name = 'person', id_number_enc = '\\x00',
                id_number_last4 = '0000', email = 'erased-' || id || '@invalid', phone = '',
                employer = null, monthly_income_cents = 0, cognito_sub = null, erased_at = now()
          where id = $1`,
        [applicant.id],
      );
    }

    await run('delete from notification where recipient_sub = $1', [sub]);
    await run('delete from notification_preference where person_sub = $1', [sub]);
    await run('delete from local_credential where sub = $1', [sub]);
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
    detail: { personSub: sub, files: keys.length },
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
