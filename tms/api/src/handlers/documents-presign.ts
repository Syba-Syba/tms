import { z } from 'zod';
import { caller } from '../lib/auth';
import { query } from '../lib/db';
import { storage } from '../lib/storage';
import { badRequest, json, notFound, parseBody, route } from '../lib/http';

const schema = z.object({
  kind: z.enum(['id_copy', 'payslip', 'bank_statement', 'proof_of_address', 'other']),
  contentType: z.enum(['image/jpeg', 'image/png', 'application/pdf']),
  sizeBytes: z.number().int().positive().max(10 * 1024 * 1024, 'Files must be under 10 MB.'),
});

export const handler = route(async (event) => {
  const person = caller(event);
  const applicationId = event.pathParameters?.id;
  if (!applicationId) throw badRequest('An application id is required.');
  const input = parseBody(event, schema);

  const [application] = await query<{ id: string; status: string }>(
    `select a.id, a.status from application a
       join applicant p on p.id = a.applicant_id
      where a.id = $1 and (p.cognito_sub = $2 or $3)`,
    [applicationId, person.sub, person.groups.includes('landlord')],
  );
  if (!application) throw notFound('Application');
  if (!['draft', 'submitted', 'screening'].includes(application.status)) {
    throw badRequest('This application is closed to new documents.');
  }

  const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' }[
    input.contentType
  ];
  const key = `applications/${applicationId}/${input.kind}/${crypto.randomUUID()}.${extension}`;

  // The browser uploads straight to S3, so a 10 MB payslip never travels through Lambda.
  const uploadUrl = await storage().presignPut(key, input.contentType, 300);

  await query(
    `insert into application_document (application_id, kind, s3_key, content_type, size_bytes)
     values ($1, $2, $3, $4, $5)`,
    [applicationId, input.kind, key, input.contentType, input.sizeBytes],
  );

  return json(201, { uploadUrl, key, expiresInSeconds: 300 });
});
