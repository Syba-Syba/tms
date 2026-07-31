import { z } from 'zod';
import { requireLeaseAccess } from '../lib/access';
import { caller } from '../lib/auth';
import { query } from '../lib/db';
import { json, notFound, parseBody, route } from '../lib/http';
import { storage } from '../lib/storage';

const schema = z.object({ key: z.string().min(1).max(500) });

/**
 * Uploads go to storage directly, so this is the one place reads come back out. Authorisation
 * is a lookup: the key must belong to a record the caller is a party to, which keeps a leaked
 * or guessed key worthless. Signature images are deliberately unreachable from here.
 */
const leaseIdFor = async (key: string): Promise<string | null> => {
  const lookups: Array<[string, string]> = [
    ['select id as lease_id from lease where pdf_s3_key = $1', 'leases/'],
    ['select lease_id from invoice where pdf_s3_key = $1', 'invoices/'],
    ['select lease_id from inspection where pdf_s3_key = $1 or draft_s3_key = $1', 'inspections/'],
    [
      `select f.inspection_id, i.lease_id from inspection_photo p
         join inspection_finding f on f.id = p.finding_id
         join inspection i on i.id = f.inspection_id
        where p.s3_key = $1`,
      'inspections/',
    ],
    ['select t.lease_id from ticket_photo p join ticket t on t.id = p.ticket_id where p.s3_key = $1', 'tickets/'],
    ['select lease_id from termination where statement_s3_key = $1', 'terminations/'],
    [
      `select t.lease_id from deposit_deduction d
         join termination t on t.id = d.termination_id
        where d.evidence_s3_key = $1`,
      '',
    ],
  ];
  for (const [sql, prefix] of lookups) {
    if (prefix && !key.startsWith(prefix)) continue;
    const [row] = await query<{ lease_id: string }>(sql, [key]);
    if (row) return row.lease_id;
  }
  return null;
};

export const handler = route(async (event) => {
  const person = caller(event);
  const { key } = parseBody(event, schema);

  if (key.startsWith('applications/')) {
    const [document] = await query<{ tenant_sub: string | null }>(
      `select p.cognito_sub as tenant_sub
         from application_document d
         join application a on a.id = d.application_id
         join applicant p on p.id = a.applicant_id
        where d.s3_key = $1`,
      [key],
    );
    if (!document) throw notFound('Document');
    if (document.tenant_sub !== person.sub && !person.groups.includes('landlord')) {
      throw notFound('Document');
    }
  } else {
    const leaseId = await leaseIdFor(key);
    if (!leaseId) throw notFound('Document');
    // A 403 confirms the key exists; an outsider learns nothing from a uniform 404.
    await requireLeaseAccess(event, leaseId).catch(() => {
      throw notFound('Document');
    });
  }

  const viewUrl = await storage().presignGet(key, 300);
  return json(200, { viewUrl, expiresInSeconds: 300 });
});
