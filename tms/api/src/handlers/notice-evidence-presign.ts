import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireLeaseAccess } from '../lib/access';
import { query } from '../lib/db';
import { badRequest, conflict, forbidden, json, notFound, parseBody, route } from '../lib/http';
import { storage } from '../lib/storage';
import { requireUploadLinkAllowance, uploadLinksByAccount } from '../lib/ratelimit';

/** Uploads started and not yet attached to a notice that one lease may have in an hour. */
export const MAX_PENDING_NOTICE_EVIDENCE = 5;

const schema = z.object({
  contentType: z.enum(['image/jpeg', 'image/png', 'application/pdf']),
  sizeBytes: z.number().int().positive().max(10 * 1024 * 1024, 'Files must be under 10 MB.'),
});

const EXTENSION = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' } as const;

/**
 * An upload link for the tenant's written notice (the letter, email or message), which the
 * landlord then attaches when recording or attesting to the notice. The same two steps as a
 * payment slip: the link is recorded here, and the file is checked when it is attached.
 */
export const handler = route(async (event) => {
  const leaseId = event.pathParameters?.id;
  if (!leaseId) throw badRequest('A lease id is required.');
  const access = await requireLeaseAccess(event, leaseId);
  if (!access.isLandlord) throw forbidden('Only the landlord attaches the tenant’s written notice.');
  const input = parseBody(event, schema);
  requireUploadLinkAllowance(access.person.sub);

  const [lease] = await query<{ status: string }>('select status from lease where id = $1', [leaseId]);
  if (!lease) throw notFound('Lease');
  if (lease.status !== 'active') throw conflict(`This lease is ${lease.status}.`);

  const [pending] = await query<{ n: number }>(
    `select count(*)::int as n from notice_evidence
      where lease_id = $1 and created_at > now() - interval '1 hour'`,
    [leaseId],
  );
  if (pending!.n >= MAX_PENDING_NOTICE_EVIDENCE) {
    throw conflict('Several files are still uploading for this lease. Attach one of those, or try again in an hour.');
  }

  const key = `notice-evidence/${leaseId}/${randomUUID()}.${EXTENSION[input.contentType]}`;
  const uploadUrl = await storage().presignPut(key, input.contentType, 300, input.sizeBytes);
  await query('insert into notice_evidence (s3_key, lease_id, created_by) values ($1, $2, $3)', [
    key, leaseId, access.person.sub,
  ]);
  uploadLinksByAccount.record(access.person.sub);
  return json(201, { evidenceKey: key, uploadUrl, expiresInSeconds: 300 });
});
