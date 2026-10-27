import { z } from 'zod';
import { requireLeaseAccessVia } from '../lib/access';
import { audit } from '../lib/audit';
import { query, withTransaction } from '../lib/db';
import { badRequest, conflict, forbidden, json, parseBody, route } from '../lib/http';
import { notify } from '../lib/notify';
import { allocatePayment, balanceLineFor, notifyPaymentReceived } from '../lib/payments';
import { zar } from '../domain/money';

const schema = z.discriminatedUnion('decision', [
  z.object({
    decision: z.literal('accept'),
    // What actually reached the account. Defaults to the slip's figure.
    amountCents: z.number().int().positive().optional(),
  }),
  z.object({
    decision: z.literal('reject'),
    reason: z.string().trim().min(3, 'Say why, so the tenant can fix it.').max(300),
  }),
]);

/**
 * The landlord checks the slip against the bank account. Accepting records real payment rows,
 * spread over the open invoices oldest first; rejecting tells the tenant why.
 */
export const handler = route(async (event) => {
  const proofId = event.pathParameters?.id;
  if (!proofId) throw badRequest('A proof id is required.');
  const access = await requireLeaseAccessVia(
    event,
    'select lease_id from payment_proof where id = $1',
    [proofId],
    'Proof of payment',
  );
  if (!access.isLandlord) throw forbidden('Only the landlord accepts or rejects a slip.');
  const input = parseBody(event, schema);

  const outcome = await withTransaction(async (run) => {
    const [proof] = await run<{
      status: string; target: string; invoice_id: string | null; amount_cents: string;
      paid_on: string; reference: string | null;
    }>(
      `select status, target, invoice_id, amount_cents, paid_on::text, reference
         from payment_proof where id = $1 for update`,
      [proofId],
    );
    if (!proof || proof.status !== 'pending') throw conflict('That slip has already been dealt with.');

    if (input.decision === 'reject') {
      await run(
        `update payment_proof set status = 'rejected', reject_reason = $2, reviewed_by = $3, reviewed_at = now()
          where id = $1`,
        [proofId, input.reason, access.person.sub],
      );
      return { decision: 'reject' as const, amountCents: Number(proof.amount_cents), paidOn: proof.paid_on };
    }

    const amountCents = input.amountCents ?? Number(proof.amount_cents);
    const reference = proof.reference ?? 'Proof of payment';
    let allocations: Awaited<ReturnType<typeof allocatePayment>> = [];
    if (proof.target === 'deposit') {
      await run(
        `insert into deposit_ledger (lease_id, entry_type, amount_cents, occurred_on, note)
         values ($1, 'received', $2, $3, $4)`,
        [access.leaseId, amountCents, proof.paid_on, reference],
      );
    } else {
      allocations = await allocatePayment(run, {
        leaseId: access.leaseId,
        amountCents,
        invoiceId: proof.invoice_id,
        method: 'eft',
        reference,
        receivedOn: proof.paid_on,
        recordedBy: access.person.sub,
        proofId,
      });
    }
    await run(
      `update payment_proof set status = 'accepted', reviewed_by = $2, reviewed_at = now() where id = $1`,
      [proofId, access.person.sub],
    );
    return { decision: 'accept' as const, amountCents, paidOn: proof.paid_on, target: proof.target, allocations };
  });

  if (outcome.decision === 'accept') {
    await notifyPaymentReceived(
      access.leaseId,
      outcome.amountCents,
      outcome.paidOn,
      outcome.target === 'deposit' ? 'It has been added to your deposit.' : balanceLineFor(outcome.allocations),
    );
  } else {
    const [tenant] = await query<{ sub: string | null; email: string; phone: string; unit: string }>(
      `select a.cognito_sub as sub, a.email, a.phone, p.name || ' ' || u.code as unit
         from lease l
         join applicant a on a.id = l.applicant_id
         join unit u on u.id = l.unit_id
         join property p on p.id = u.property_id
        where l.id = $1`,
      [access.leaseId],
    );
    if (tenant?.sub) {
      await notify({
        leaseId: access.leaseId,
        to: { sub: tenant.sub, email: tenant.email, phone: tenant.phone },
        kind: 'proof_rejected',
        data: {
          amount: zar(outcome.amountCents),
          paidOn: outcome.paidOn,
          reason: input.decision === 'reject' ? input.reason : '',
          unit: tenant.unit,
        },
      });
    }
  }

  await audit({
    actorSub: access.person.sub,
    actorRole: 'landlord',
    action: `payment_proof.${outcome.decision === 'accept' ? 'accepted' : 'rejected'}`,
    entity: 'lease',
    entityId: access.leaseId,
    detail: { proofId, amountCents: outcome.amountCents },
  });
  return json(200, outcome);
});
