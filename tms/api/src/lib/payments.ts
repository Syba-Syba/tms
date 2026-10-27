import { conflict } from './http';
import { notify } from './notify';
import { query } from './db';
import { zar } from '../domain/money';

type Run = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

export interface Allocation {
  invoiceId: string;
  amountCents: number;
  status: 'paid' | 'part_paid';
}

export interface IncomingPayment {
  leaseId: string;
  amountCents: number;
  /**
   * Settled first when it is still open. A slip names the month the tenant meant, and that
   * month may have been paid another way since, so a settled one is passed over, not refused.
   * Anything left over goes to the oldest open invoices.
   */
  invoiceId?: string | null;
  method: 'eft' | 'cash' | 'gateway';
  reference: string | null;
  receivedOn: string;
  recordedBy: string;
  proofId?: string | null;
  bankLineId?: string | null;
}

/**
 * Spreads one amount across a lease's open invoices and records a payment row per invoice.
 *
 * Tenants routinely pay two months at once, or catch up arrears in one transfer, and a bank
 * line or a slip is one amount. Recording it against a single invoice either rejected it as an
 * overpayment or left an older invoice open. Overpaying the whole lease is still refused: there
 * is nowhere to hold credit yet, and guessing would corrupt the statement.
 *
 * Call inside a transaction. Every touched invoice is locked first.
 */
export async function allocatePayment(run: Run, input: IncomingPayment): Promise<Allocation[]> {
  const open = await run<{ id: string; total_cents: string; paid: string }>(
    `select i.id, i.total_cents,
            coalesce((select sum(p.amount_cents) from payment p where p.invoice_id = i.id), 0)::text as paid
       from invoice i
      where i.lease_id = $1 and i.status in ('issued', 'part_paid')
      order by (i.id = $2) desc, i.period_start
        for update`,
    [input.leaseId, input.invoiceId ?? null],
  );
  let left = input.amountCents;
  const allocations: Allocation[] = [];
  for (const invoice of open) {
    if (left === 0) break;
    const outstanding = Number(invoice.total_cents) - Number(invoice.paid);
    if (outstanding <= 0) continue;
    const amount = Math.min(left, outstanding);
    left -= amount;
    allocations.push({
      invoiceId: invoice.id,
      amountCents: amount,
      status: amount === outstanding ? 'paid' : 'part_paid',
    });
  }
  if (left > 0) {
    const owed = input.amountCents - left;
    throw conflict(
      owed === 0
        ? 'Nothing is owed on this lease yet. Wait for the next invoice, then record it.'
        : `That is ${zar(left)} more than the ${zar(owed)} owed. Record ${zar(owed)} now and the rest once the next invoice is issued.`,
    );
  }

  for (const allocation of allocations) {
    await run(
      `insert into payment (lease_id, invoice_id, amount_cents, method, reference, received_on,
                            recorded_by, proof_id, bank_line_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        input.leaseId, allocation.invoiceId, allocation.amountCents, input.method,
        input.reference?.slice(0, 60) ?? null, input.receivedOn, input.recordedBy,
        input.proofId ?? null, input.bankLineId ?? null,
      ],
    );
    await run('update invoice set status = $2 where id = $1', [allocation.invoiceId, allocation.status]);
  }
  return allocations;
}

/** The tenant hears about money the moment it is recorded, whoever recorded it. */
export async function notifyPaymentReceived(
  leaseId: string,
  amountCents: number,
  receivedOn: string,
  balanceLine: string,
): Promise<void> {
  const [tenant] = await query<{ sub: string | null; email: string; phone: string; unit: string }>(
    `select a.cognito_sub as sub, a.email, a.phone, p.name || ' ' || u.code as unit
       from lease l
       join applicant a on a.id = l.applicant_id
       join unit u on u.id = l.unit_id
       join property p on p.id = u.property_id
      where l.id = $1`,
    [leaseId],
  );
  if (!tenant?.sub) return;
  await notify({
    leaseId,
    to: { sub: tenant.sub, email: tenant.email, phone: tenant.phone },
    kind: 'payment_received',
    data: { amount: zar(amountCents), receivedOn, balanceLine, unit: tenant.unit },
  });
}

export const balanceLineFor = (allocations: Allocation[]) =>
  allocations.every((allocation) => allocation.status === 'paid')
    ? allocations.length > 1
      ? `That settles ${allocations.length} invoices, thank you.`
      : 'That settles the invoice, thank you.'
    : 'Part of the invoice is still outstanding.';
