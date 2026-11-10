import { z } from 'zod';
import { requireLeaseAccessVia } from '../lib/access';
import { audit } from '../lib/audit';
import { query, withTransaction } from '../lib/db';
import { badRequest, conflict, forbidden, json, notFound, parseBody, route } from '../lib/http';
import { logger } from '../lib/logger';
import { notify } from '../lib/notify';
import { lockLease } from '../lib/payments';
import { zar } from '../domain/money';

const schema = z.object({ reason: z.string().trim().min(3).max(200) });

/**
 * Undoes a payment recorded by mistake: the wrong lease, amount or date. Nothing is deleted.
 * A negative 'reversal' entry goes against the same invoice, dated as the payment was so every
 * period report nets it out, and the invoice is re-opened to what is now paid on it. The
 * landlord then records the payment again correctly. One payment is reversed once; asking
 * again returns the same reversal. Refused once the deposit is settled: the statement was
 * drawn from these payments.
 */
export const handler = route(async (event) => {
  const paymentId = event.pathParameters?.id;
  if (!paymentId) throw badRequest('A payment id is required.');
  const access = await requireLeaseAccessVia(
    event,
    'select lease_id from payment where id = $1',
    [paymentId],
    'Payment',
  );
  if (!access.isLandlord) throw forbidden('Only the landlord reverses a payment.');
  const input = parseBody(event, schema);
  const leaseId = access.leaseId;

  const result = await withTransaction(async (run) => {
    // The lease first, as every path that records money does.
    await lockLease(run, leaseId);
    const [payment] = await run<{
      id: string; invoice_id: string | null; amount_cents: string; method: string; received_on: string;
    }>(
      'select id, invoice_id, amount_cents::text, method, received_on::text from payment where id = $1 for update',
      [paymentId],
    );
    if (!payment) throw notFound('Payment');

    const invoiceNow = async () => {
      if (!payment.invoice_id) return { invoiceStatus: null, paidCents: 0, totalCents: 0 };
      const [invoice] = await run<{ status: string; total: string; paid: string }>(
        `select i.status, i.total_cents::text as total,
                coalesce((select sum(p.amount_cents) from payment p where p.invoice_id = i.id), 0)::text as paid
           from invoice i where i.id = $1 for update of i`,
        [payment.invoice_id],
      );
      return { invoiceStatus: invoice!.status, paidCents: Number(invoice!.paid), totalCents: Number(invoice!.total) };
    };

    const [already] = await run<{ id: string; amount_cents: string }>(
      'select id, amount_cents::text from payment where reverses_payment_id = $1',
      [paymentId],
    );
    if (already) {
      return {
        reversalId: already.id, paymentId, amountCents: Number(already.amount_cents),
        invoiceId: payment.invoice_id, ...(await invoiceNow()), duplicate: true, receivedOn: payment.received_on,
      };
    }
    if (payment.method === 'reversal') throw conflict('That entry is itself a reversal. Record the payment again instead.');
    // Settlement wrote these itself; undoing one would unbalance the deposit statement.
    if (payment.method === 'deposit' || payment.method === 'refund') {
      throw conflict('That entry was made by the deposit settlement and cannot be reversed.');
    }
    const [settled] = await run<{ id: string }>(
      `select id from termination where lease_id = $1 and status = 'settled'`,
      [leaseId],
    );
    if (settled) {
      throw conflict('The deposit on this lease is settled, and its statement was drawn from these payments, so they can no longer be reversed.');
    }

    const amount = Number(payment.amount_cents);
    const [reversal] = await run<{ id: string }>(
      `insert into payment (lease_id, invoice_id, amount_cents, method, reference, received_on, recorded_by,
                            reverses_payment_id, reversal_reason)
       values ($1, $2, $3, 'reversal', $4, $5, $6, $7, $8)
       returning id`,
      [leaseId, payment.invoice_id, -amount, `Reversal: ${input.reason}`.slice(0, 60), payment.received_on,
        access.person.sub, paymentId, input.reason],
    );
    let state = await invoiceNow();
    // A void invoice stays void; any other goes back to what is now paid on it.
    if (payment.invoice_id && state.invoiceStatus !== 'void') {
      const status = state.paidCents >= state.totalCents && state.paidCents > 0 ? 'paid' : state.paidCents > 0 ? 'part_paid' : 'issued';
      await run('update invoice set status = $2 where id = $1', [payment.invoice_id, status]);
      state = { ...state, invoiceStatus: status };
    }
    await audit(
      {
        actorSub: access.person.sub,
        actorRole: 'landlord',
        action: 'payment.reversed',
        entity: 'lease',
        entityId: leaseId,
        detail: {
          paymentId, reversalId: reversal!.id, amountCents: amount, receivedOn: payment.received_on,
          invoiceId: payment.invoice_id, reason: input.reason,
        },
      },
      run,
    );
    return {
      reversalId: reversal!.id, paymentId, amountCents: -amount, invoiceId: payment.invoice_id, ...state,
      duplicate: false, receivedOn: payment.received_on,
    };
  });

  const { receivedOn: _receivedOn, ...body } = result;
  if (result.duplicate) return json(200, body);

  // Committed. The tenant was told the money had arrived, so they are told it was taken back.
  try {
    const [tenant] = await query<{ sub: string | null; email: string; phone: string; unit: string }>(
      `select a.cognito_sub as sub, a.email, a.phone, p.name || ' ' || u.code as unit
         from lease l
         join applicant a on a.id = l.applicant_id
         join unit u on u.id = l.unit_id
         join property p on p.id = u.property_id
        where l.id = $1`,
      [leaseId],
    );
    if (tenant?.sub) {
      await notify({
        leaseId,
        to: { sub: tenant.sub, email: tenant.email, phone: tenant.phone },
        kind: 'payment_reversed',
        dedupeKey: `payment_reversed:${paymentId}`,
        data: {
          amount: zar(-result.amountCents), receivedOn: result.receivedOn, reason: input.reason, unit: tenant.unit,
        },
      });
    }
  } catch (error) {
    logger.error('Payment reversed but the tenant could not be told.', { leaseId, error });
  }

  return json(201, body);
});
