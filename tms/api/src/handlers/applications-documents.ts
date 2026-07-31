import { caller } from '../lib/auth';
import { query } from '../lib/db';
import { badRequest, json, notFound, route } from '../lib/http';
import { storage } from '../lib/storage';

/** The queue shows a document count; this is what lets the landlord actually read them. */
export const handler = route(async (event) => {
  const person = caller(event);
  const applicationId = event.pathParameters?.id;
  if (!applicationId) throw badRequest('An application id is required.');

  const [application] = await query<{ id: string }>(
    `select a.id from application a
       join applicant p on p.id = a.applicant_id
      where a.id = $1 and (p.cognito_sub = $2 or $3)`,
    [applicationId, person.sub, person.groups.includes('landlord')],
  );
  if (!application) throw notFound('Application');

  const rows = await query<{
    id: string;
    kind: string;
    content_type: string;
    size_bytes: string;
    uploaded_at: string;
  }>(
    `select id, kind, content_type, size_bytes, uploaded_at, s3_key
       from application_document
      where application_id = $1
      order by uploaded_at`,
    [applicationId],
  );

  const items = await Promise.all(
    rows.map(async (row: (typeof rows)[number] & { s3_key?: string }) => ({
      id: row.id,
      kind: row.kind,
      contentType: row.content_type,
      sizeBytes: Number(row.size_bytes),
      uploadedAt: row.uploaded_at,
      viewUrl: await storage().presignGet(row.s3_key!, 300),
    })),
  );

  return json(200, { items });
});
