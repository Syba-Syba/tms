import { z } from 'zod';
import { requireApplicationAccess, requireLeaseAccess } from '../lib/access';
import { caller } from '../lib/auth';
import { query } from '../lib/db';
import { json, notFound, parseBody, route } from '../lib/http';
import { storage } from '../lib/storage';
import { audit } from '../lib/audit';

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
    ['select lease_id from payment_proof where s3_key = $1', 'payment-proofs/'],
    [
      'select c.lease_id from arrears_step s join arrears_case c on c.id = s.case_id where s.document_s3_key = $1',
      'arrears/',
    ],
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
  const { key } = parseBody(event, schema);
  let entity: 'application' | 'lease' | 'expense';
  let entityId: string;

  if (key.startsWith('expenses/')) {
    // An expense slip belongs to a landlord, not a lease, so no tenant can ever reach one.
    const person = caller(event);
    const [slip] = await query<{ id: string; is_member: boolean }>(
      `select e.id, exists (select 1 from landlord_member m where m.landlord_id = e.landlord_id and m.sub = $2) as is_member
         from expense e where e.slip_s3_key = $1`,
      [key, person.sub],
    );
    if (!slip || !slip.is_member || !person.groups.includes('landlord')) throw notFound('Document');
    entity = 'expense';
    entityId = slip.id;
  } else if (key.startsWith('applications/')) {
    // ID copies, payslips and bank statements. Membership of the landlord group used to be
    // enough to read any of them, for any applicant, under any landlord.
    const [document] = await query<{ application_id: string }>(
      'select application_id from application_document where s3_key = $1',
      [key],
    );
    if (!document) throw notFound('Document');
    await requireApplicationAccess(event, document.application_id).catch(() => {
      throw notFound('Document');
    });
    entity = 'application';
    entityId = document.application_id;
  } else {
    const leaseId = await leaseIdFor(key);
    if (!leaseId) throw notFound('Document');
    // A 403 confirms the key exists; an outsider learns nothing from a uniform 404.
    await requireLeaseAccess(event, leaseId).catch(() => {
      throw notFound('Document');
    });
    entity = 'lease';
    entityId = leaseId;
  }

  // Who opened an ID copy or a payslip, and when, is a POPIA question the log has to answer.
  const person = caller(event);
  await audit({
    actorSub: person.sub,
    actorRole: person.groups[0] ?? 'unknown',
    action: 'file.viewed',
    entity,
    entityId,
    detail: { key },
  });

  const viewUrl = await storage().presignGet(key, 300);
  return json(200, { viewUrl, expiresInSeconds: 300 });
});
