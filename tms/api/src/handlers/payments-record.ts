import { z } from 'zod';
import { requireLeaseAccess } from '../lib/access';
import { forbidden } from '../lib/http';
import { audit } from '../lib/audit';
import { query, withTransaction } from '../lib/db';
import { badRequest, conflict, json, notFound, parseBody, route } from '../lib/http';
import { notify } from '../lib/notify';
import { zar } from '../domain/money';

const schema = z.object({
  target: z.enum(['invoice', 'deposit']),
  invoiceId: z.guid().optional(),
  amountCents: z.number().int().positive(),
  method: z.enum(['eft', 'cash', 'gateway']).default('eft'),
  reference: z.string().max(60).optional(),
  receivedOn: z.coerce.date(),
});

export const handler = route(async (event) => {
  const leaseId = event.pathParameters?.id;
  if (!leaseId) throw badRequest('A lease id is required.');
  const access = await requireLeaseAccess(event, leaseId);
  if (!access.isLandlord) throw forbidden('Only the landlord records a payment.');
  const person = access.person;
  const input = parseBody(event, schema);
  if (input.target === 'invoice' && !input.invoiceId) {
    throw badRequest('Pick the invoice this payment settles.');
  }

  const result = await withTransaction(async (run) => {
    if (input.target === 'deposit') {
      await run(
        `insert into deposit_ledger (lease_id, entry_type, amount_cents, occurred_on, note)
         values ($1, 'received', $2, $3, $4)`,
        [leaseId, input.amountCents, input.receivedOn, input.reference ?? null],
      );
      return { target: 'deposit' as const };
    }

    const [invoice] = await run<{ id: string; total_cents: string; status: string }>(
      'select id, total_cents, status from invoice where id = $1 and lease_id = $2 for update',
      [input.invoiceId, leaseId],
    );
    if (!invoice) throw notFound('Invoice');
    if (invoice.status === 'void') throw conflict('That invoice is void.');

    await run(
      `insert into payment (lease_id, invoice_id, amount_cents, method, reference, received_on, recorded_by)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [leaseId, invoice.id, input.amountCents, input.method, input.reference ?? null, input.receivedOn, person.sub],
    );

    const rows = await run<{ paid: string }>(
      'select coalesce(sum(amount_cents), 0)::text as paid from payment where invoice_id = $1',
      [invoice.id],
    );
    const paid = Number(rows[0]?.paid ?? 0);
    const total = Number(invoice.total_cents);
    // Overpayment is a bookkeeping mess, not a bonus. Reject it and let the landlord split it.
    if (paid > total) {
      throw conflict('That would overpay the invoice. Record the excess against the next one.');
    }
    const status = paid === total ? 'paid' : 'part_paid';
    await run('update invoice set status = $2 where id = $1', [invoice.id, status]);
    return { target: 'invoice' as const, invoiceStatus: status, paidCents: paid, totalCents: total };
  });

  const [tenant] = await query<{
    sub: string | null; email: string; phone: string; unit: string;
  }>(
    `select a.cognito_sub as sub, a.email, a.phone, p.name || ' ' || u.code as unit
       from lease l
       join applicant a on a.id = l.applicant_id
       join unit u on u.id = l.unit_id
       join property p on p.id = u.property_id
      where l.id = $1`,
    [leaseId],
  );
  if (tenant?.sub) {
    const settled = result.target === 'invoice' && result.invoiceStatus === 'paid';
    await notify({
      leaseId,
      to: { sub: tenant.sub, email: tenant.email, phone: tenant.phone },
      kind: 'payment_received',
      data: {
        amount: zar(input.amountCents),
        receivedOn: input.receivedOn.toISOString().slice(0, 10),
        balanceLine: settled
          ? 'That settles the invoice, thank you.'
          : result.target === 'deposit'
            ? 'It has been added to your deposit.'
            : 'Part of the invoice is still outstanding.',
        unit: tenant.unit,
      },
    });
  }

  await audit({
    actorSub: person.sub,
    actorRole: 'landlord',
    action: 'payment.recorded',
    entity: 'lease',
    entityId: leaseId,
    detail: { ...input, receivedOn: input.receivedOn.toISOString().slice(0, 10) },
  });

  return json(201, result);
});
