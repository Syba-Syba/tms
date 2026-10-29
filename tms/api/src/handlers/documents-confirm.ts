import { z } from 'zod';
import { requireApplicationAccess } from '../lib/access';
import { withTransaction } from '../lib/db';
import { storage } from '../lib/storage';
import { badRequest, json, notFound, parseBody, route } from '../lib/http';
import { sniffImageType } from '../lib/images';

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

const schema = z.object({ key: z.string().min(1).max(300) });

const KEY = /^applications\/([0-9a-f-]{36})\/(id_copy|payslip|bank_statement|proof_of_address|other|credit_report)\/[0-9a-f-]{36}\.(jpg|png|pdf)$/;

const isPdf = (bytes: Uint8Array) =>
  bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString('latin1') === '%PDF-';

/** The client calls this after the PUT succeeds. Only a confirmed upload is on file for the
    landlord, so a failed PUT no longer shows as a document that does not exist. */
export const handler = route(async (event) => {
  const applicationId = event.pathParameters?.id;
  if (!applicationId) throw badRequest('An application id is required.');
  const input = parseBody(event, schema);

  const access = await requireApplicationAccess(event, applicationId);

  const parts = KEY.exec(input.key);
  if (!parts || parts[1] !== applicationId) throw badRequest('That upload is not for this application.');
  const kind = parts[2]!;
  if (kind === 'credit_report' && !access.isLandlord) throw badRequest('Only the landlord files a credit report.');

  let size: number | null;
  try {
    size = await storage().sizeOf(input.key);
  } catch {
    size = null;
  }
  if (size === null) throw badRequest('That upload has not landed yet. Retry the upload, then confirm.');
  // A presigned PUT does not bind the body to the declared size, so the ceiling is checked here.
  // A refused upload is deleted, not left in storage where no row (and so no erasure) finds it.
  const refuse = async (message: string) => {
    await storage().remove(input.key).catch(() => undefined);
    return badRequest(message);
  };
  if (size > MAX_DOCUMENT_BYTES) throw await refuse('Files must be under 10 MB.');

  // The stored type follows the bytes, not the label the client sent.
  const bytes = await storage().get(input.key);
  const image = sniffImageType(bytes);
  const contentType = image === 'png' ? 'image/png' : image === 'jpg' ? 'image/jpeg' : isPdf(bytes) ? 'application/pdf' : null;
  if (!contentType) throw await refuse('That upload is not a JPEG, PNG or PDF.');

  const replaced = await withTransaction(async (run) => {
    const [application] = await run<{ status: string }>(
      'select status from application where id = $1 for update',
      [applicationId],
    );
    if (!application) throw notFound('Application');
    if (!['draft', 'submitted', 'screening'].includes(application.status)) {
      throw badRequest('This application is closed to new documents.');
    }
    // A confirm sent twice is one document.
    const [existing] = await run<{ id: string }>(
      'select id from application_document where s3_key = $1',
      [input.key],
    );
    if (existing) return [];
    // The upload screen keeps one document per kind, so Replace supersedes the earlier one, and
    // its file goes with it. Left in storage, an old ID copy survived erasure and the sweep,
    // which only find files through these rows.
    let old: { s3_key: string }[] = [];
    if (kind !== 'other') {
      old = await run<{ s3_key: string }>(
        'delete from application_document where application_id = $1 and kind = $2 returning s3_key',
        [applicationId, kind],
      );
    }
    await run(
      `insert into application_document (application_id, kind, s3_key, content_type, size_bytes)
       values ($1, $2, $3, $4, $5)`,
      [applicationId, kind, input.key, contentType, size],
    );
    return old.map((row) => row.s3_key);
  });
  for (const key of replaced) await storage().remove(key).catch(() => undefined);

  return json(200, { confirmed: true });
});
