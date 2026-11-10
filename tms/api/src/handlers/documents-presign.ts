import { z } from 'zod';
import { requireApplicationAccess } from '../lib/access';
import { hasCreditConsent } from './credit-check';
import { query } from '../lib/db';
import { storage } from '../lib/storage';
import { badRequest, conflict, forbidden, json, notFound, parseBody, route } from '../lib/http';
import { requireUploadLinkAllowance, uploadLinksByAccount } from '../lib/ratelimit';

/** Unconfirmed document uploads one application may have in the last hour. */
export const MAX_PENDING_DOCUMENTS = 20;
/**
 * 'Other' documents one application may keep. Every other kind is one per application (a new
 * one replaces the old), but 'other' adds up, and a loop of 10 MB files filled the disk.
 */
export const MAX_OTHER_DOCUMENTS = 10;
/**
 * The applicant's own evidence. Filed by the landlord, a new one replaced (and deleted) the
 * applicant's, with nothing to show who uploaded it.
 */
export const APPLICANT_KINDS = ['id_copy', 'payslip', 'bank_statement', 'proof_of_address'];

const schema = z.object({
  kind: z.enum(['id_copy', 'payslip', 'bank_statement', 'proof_of_address', 'other', 'credit_report']),
  contentType: z.enum(['image/jpeg', 'image/png', 'application/pdf']),
  sizeBytes: z.number().int().positive().max(10 * 1024 * 1024, 'Files must be under 10 MB.'),
});

/** SQL for every kept key an upload key may have become: confirm stores a checked copy. */
export const keptKeySql = (uploadKey: string) =>
  `regexp_replace(${uploadKey}, '\\.(jpg|png|pdf)$', '.kept.jpg'),
   regexp_replace(${uploadKey}, '\\.(jpg|png|pdf)$', '.kept.png'),
   regexp_replace(${uploadKey}, '\\.(jpg|png|pdf)$', '.kept.pdf')`;

export const handler = route(async (event) => {
  const applicationId = event.pathParameters?.id;
  if (!applicationId) throw badRequest('An application id is required.');
  const input = parseBody(event, schema);

  const access = await requireApplicationAccess(event, applicationId);
  requireUploadLinkAllowance(access.person.sub);
  if (!access.isApplicant && APPLICANT_KINDS.includes(input.kind)) {
    throw forbidden('Only the applicant files their own documents.');
  }
  // A bureau report is the landlord's to file, and only once the applicant agreed to the check.
  if (input.kind === 'credit_report') {
    if (!access.isLandlord) throw badRequest('Only the landlord files a credit report.');
    if (!(await hasCreditConsent(applicationId))) throw badRequest('The applicant has not agreed to a credit check.');
  }

  const [application] = await query<{ id: string; status: string }>(
    'select id, status from application where id = $1',
    [applicationId],
  );
  if (!application) throw notFound('Application');
  if (!['draft', 'submitted', 'screening'].includes(application.status)) {
    throw badRequest('This application is closed to new documents.');
  }

  // Links not yet taken up by a confirmed document count for an hour, until the uploads sweep
  // deletes whatever was put there. Without this a loop of presign calls filled the disk.
  const [pending] = await query<{ n: number }>(
    `select count(*)::int as n from pending_upload pu
      where pu.application_id = $1 and pu.created_at > now() - interval '1 hour'
        and not exists (select 1 from application_document d where d.s3_key in (pu.s3_key, ${keptKeySql('pu.s3_key')}))`,
    [applicationId],
  );
  if (pending!.n >= MAX_PENDING_DOCUMENTS) {
    throw conflict('Too many uploads are waiting to be confirmed on this application. Finish those first, or try again in an hour.');
  }

  if (input.kind === 'other') {
    const [kept] = await query<{ n: number }>(
      `select count(*)::int as n from application_document where application_id = $1 and kind = 'other'`,
      [applicationId],
    );
    if (kept!.n >= MAX_OTHER_DOCUMENTS) {
      throw conflict(`An application holds up to ${MAX_OTHER_DOCUMENTS} other documents. Remove one first.`);
    }
  }

  const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' }[
    input.contentType
  ];
  const key = `applications/${applicationId}/${input.kind}/${crypto.randomUUID()}.${extension}`;

  // The browser uploads straight to S3, so a 10 MB payslip never travels through Lambda.
  // Not on file yet: the document is on file only once /documents/confirm sees it landed. The
  // key is recorded as pending so the uploads sweep can delete it if that never happens.
  await query('insert into pending_upload (s3_key, application_id, created_by) values ($1, $2, $3)', [
    key,
    applicationId,
    access.person.sub,
  ]);
  const uploadUrl = await storage().presignPut(key, input.contentType, 300, input.sizeBytes);
  uploadLinksByAccount.record(access.person.sub);

  return json(201, { uploadUrl, key, expiresInSeconds: 300 });
});
