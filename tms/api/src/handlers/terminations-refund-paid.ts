import { requireLeaseAccessVia } from '../lib/access';
import { audit } from '../lib/audit';
import { withTransaction } from '../lib/db';
import { badRequest, conflict, forbidden, json, notFound, parseBody, route } from '../lib/http';
import { leaseParties } from '../lib/lease-parties';
import { logger } from '../lib/logger';
import { notify } from '../lib/notify';
import { refundPaidSchema } from '../domain/termination';
import { sastToday } from '../domain/dates';
import { zar } from '../domain/money';

/**
 * Records that the refund on a settled deposit was actually paid: the date and the bank
 * reference. Settlement only says what is due and by when, and the deadline is statutory, so
 * "paid on time" needs a record of its own. Sending it again corrects it; each is audited.
 */
export const handler = route(async (event) => {
  const terminationId = event.pathParameters?.id;
  if (!terminationId) throw badRequest('A termination id is required.');
  const access = await requireLeaseAccessVia(
    event,
    'select lease_id from termination where id = $1',
    [terminationId],
    'Termination',
  );
  if (!access.isLandlord) throw forbidden('Only the landlord records the refund.');
  const input = parseBody(event, refundPaidSchema);
  const today = sastToday();

  const result = await withTransaction(async (run) => {
    const [termination] = await run<{
      status: string; effective_on: string; refund: string; refund_due_by: string | null; previous: string | null;
    }>(
      // Settlements from before the refund was stored fall back to the deposit ledger's refund.
      `select t.status, t.effective_on::text, t.refund_due_by::text, t.refund_paid_on::text as previous,
              coalesce(t.refund_cents, (select sum(d.amount_cents) from deposit_ledger d
                         where d.lease_id = t.lease_id and d.entry_type = 'refund'), 0)::text as refund
         from termination t where t.id = $1 for update of t`,
      [terminationId],
    );
    if (!termination) throw notFound('Termination');
    if (termination.status !== 'settled') throw conflict('Settle the deposit first. The refund is recorded once it is.');
    if (Number(termination.refund) <= 0) throw conflict('The statement shows no refund due to the tenant.');
    if (input.paidOn > today) throw badRequest('The refund cannot be paid in the future.', { paidOn: `Use ${today} or earlier.` });
    if (input.paidOn < termination.effective_on) {
      throw badRequest('The refund cannot be paid before the lease ended.', { paidOn: `Use ${termination.effective_on} or later.` });
    }
    await run(
      `update termination
          set refund_paid_on = $2, refund_paid_reference = $3, refund_paid_recorded_by = $4, refund_paid_recorded_at = now()
        where id = $1`,
      [terminationId, input.paidOn, input.reference, access.person.sub],
    );
    await audit(
      {
        actorSub: access.person.sub,
        actorRole: 'landlord',
        action: 'termination.refund_paid',
        entity: 'termination',
        entityId: terminationId,
        detail: {
          paidOn: input.paidOn, reference: input.reference, refundCents: Number(termination.refund),
          dueBy: termination.refund_due_by, replaces: termination.previous,
        },
      },
      run,
    );
    return { refundCents: Number(termination.refund), dueBy: termination.refund_due_by, first: termination.previous === null };
  });

  // Recorded. A failure telling the tenant must not invite a second attempt.
  if (result.first) {
    try {
      const parties = await leaseParties(access.leaseId);
      if (parties) {
        await notify({
          leaseId: access.leaseId,
          to: { sub: parties.tenantSub, email: parties.tenantEmail, phone: parties.tenantPhone },
          kind: 'refund_paid',
          dedupeKey: `refund_paid:${terminationId}`,
          data: { unit: parties.unit, amount: zar(result.refundCents), paidOn: input.paidOn, reference: input.reference },
        });
      }
    } catch (error) {
      logger.error('Refund recorded but the tenant could not be told.', { terminationId, error });
    }
  }

  return json(200, {
    id: terminationId,
    refundCents: result.refundCents,
    refundDueBy: result.dueBy,
    refundPaidOn: input.paidOn,
    refundReference: input.reference,
  });
});
