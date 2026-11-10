import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireLeaseAccess } from '../lib/access';
import { query } from '../lib/db';
import { badRequest, conflict, forbidden, json, notFound, parseBody, route } from '../lib/http';
import { storage } from '../lib/storage';
import { requireUploadLinkAllowance, uploadLinksByAccount } from '../lib/ratelimit';

/** Slips started but not sent that one lease may have in the last hour. */
export const MAX_PENDING_SLIPS = 5;

const schema = z.object({
  target: z.enum(['invoice', 'deposit']).default('invoice'),
  invoiceId: z.guid().optional(),
  amountCents: z.number().int().positive().max(100_000_000),
  paidOn: z.iso.date(),
  reference: z.string().trim().max(60).optional(),
  contentType: z.enum(['image/jpeg', 'image/png', 'application/pdf']),
  sizeBytes: z.number().int().positive().max(10 * 1024 * 1024, 'Files must be under 10 MB.'),
});

const EXTENSION = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' } as const;

/**
 * Step one of sending a slip: the tenant says what they paid and gets a signed upload link.
 * The row stays 'uploading', invisible to the landlord, until submit confirms the file landed.
 */
export const handler = route(async (event) => {
  const leaseId = event.pathParameters?.id;
  if (!leaseId) throw badRequest('A lease id is required.');
  const access = await requireLeaseAccess(event, leaseId);
  if (!access.isTenant) throw forbidden('Only the tenant sends proof of payment.');
  const input = parseBody(event, schema);
  requireUploadLinkAllowance(access.person.sub);

  // A slip dated tomorrow is a typo or a promise, and neither is a payment.
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  if (input.paidOn > tomorrow) {
    throw badRequest('Some fields need fixing.', { paidOn: 'The payment date cannot be in the future.' });
  }

  const [lease] = await query<{ status: string }>('select status from lease where id = $1', [leaseId]);
  if (!lease) throw notFound('Lease');
  if (!['out_for_signature', 'active', 'terminated'].includes(lease.status)) {
    throw conflict('This lease is not taking payments.');
  }

  if (input.target === 'deposit' && input.invoiceId) {
    throw badRequest('A deposit payment is not for an invoice.');
  }
  if (input.invoiceId) {
    const [invoice] = await query<{ status: string }>(
      'select status from invoice where id = $1 and lease_id = $2',
      [input.invoiceId, leaseId],
    );
    if (!invoice) throw notFound('Invoice');
    if (!['issued', 'part_paid'].includes(invoice.status)) throw conflict('That invoice is already settled.');
  }

  // A slip started and never sent counts for an hour, until the uploads sweep deletes it.
  const [pending] = await query<{ n: number }>(
    `select count(*)::int as n from payment_proof
      where lease_id = $1 and status = 'uploading' and created_at > now() - interval '1 hour'`,
    [leaseId],
  );
  if (pending!.n >= MAX_PENDING_SLIPS) {
    throw conflict('Several slips are still uploading on this lease. Send those first, or try again in an hour.');
  }

  const key = `payment-proofs/${leaseId}/${randomUUID()}.${EXTENSION[input.contentType]}`;
  const uploadUrl = await storage().presignPut(key, input.contentType, 300, input.sizeBytes);
  const [proof] = await query<{ id: string }>(
    `insert into payment_proof (lease_id, target, invoice_id, amount_cents, paid_on, reference,
                                s3_key, content_type, size_bytes, submitted_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning id`,
    [
      leaseId, input.target, input.invoiceId ?? null, input.amountCents, input.paidOn,
      input.reference || null, key, input.contentType, input.sizeBytes, access.person.sub,
    ],
  );

  uploadLinksByAccount.record(access.person.sub);
  return json(201, { proofId: proof!.id, uploadUrl, expiresInSeconds: 300 });
});
