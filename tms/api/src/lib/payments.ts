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
 * Holds the lease row for the rest of the transaction. Every path that records money onto a
 * lease, or decides that money is already recorded (a bank line against an accepted slip, a
 * slip against a matched bank line), takes it first, so two such requests run one after the
 * other and the second sees what the first committed. Taken before any other row lock, so
 * the paths cannot deadlock on each other.
 */
export async function lockLease(run: Run, leaseId: string): Promise<void> {
  await run('select id from lease where id = $1 for update', [leaseId]);
}

/**
 * Refuses deposit money on a lease whose deposit is already settled, or that has ended. Only
 * settlement refunds or deducts a deposit, and it runs once, so money added afterwards sat on
 * the ledger with no way out. Call inside the transaction that records it.
 */
export async function assertDepositOpen(run: Run, leaseId: string): Promise<void> {
  const [row] = await run<{ status: string; settled: boolean }>(
    `select l.status,
            exists (select 1 from termination t where t.lease_id = l.id and t.status = 'settled') as settled
       from lease l where l.id = $1`,
    [leaseId],
  );
  if (!row || row.settled || row.status === 'terminated' || row.status === 'cancelled') {
    throw conflict('The deposit on this lease has been settled. Pay any money back to the tenant directly.');
  }
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
  // Money onto one lease is recorded one request at a time (callers take the same lock first).
  await lockLease(run, input.leaseId);
  const open = await run<{ id: string; total_cents: string }>(
    `select i.id, i.total_cents
       from invoice i
      where i.lease_id = $1 and i.status in ('issued', 'part_paid')
      order by (i.id = $2) desc, i.period_start
        for update`,
    [input.leaseId, input.invoiceId ?? null],
  );
  // Summed in its own statement, after the locks are held. Summed inside the locking select it
  // read the snapshot from before the wait, missed a payment committed meanwhile, and overpaid.
  const sums = await run<{ invoice_id: string; paid: string }>(
    `select invoice_id, sum(amount_cents)::text as paid from payment where invoice_id = any($1::uuid[]) group by invoice_id`,
    [open.map((invoice) => invoice.id)],
  );
  const paidOf = new Map(sums.map((row) => [row.invoice_id, Number(row.paid)]));
  let left = input.amountCents;
  const allocations: Allocation[] = [];
  for (const invoice of open) {
    if (left === 0) break;
    const outstanding = Number(invoice.total_cents) - (paidOf.get(invoice.id) ?? 0);
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
