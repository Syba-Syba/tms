import { audit } from './audit';
import { logger } from './logger';

type Run = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

/** Both signatures on file. A renewal does not go live, or get billed, on acceptance alone. */
export const FULLY_SIGNED_SQL = (alias: string) =>
  `(select count(*) from lease_signature s where s.lease_id = ${alias}.id) = 2`;

/**
 * Makes a scheduled lease the live one and retires the lease it replaced, in the caller's
 * transaction. Doing both together is what keeps lease_one_live_per_unit satisfied at every
 * instant. Used by the morning job, and by signing when the last signature lands on or after
 * the start date.
 */
export async function activateScheduledLease(
  run: Run,
  lease: { id: string; previous_lease_id: string | null; unit_id: string },
  actor: { sub: string; role: string } = { sub: 'system', role: 'job' },
) {
  if (lease.previous_lease_id) {
    await run(`update lease set status = 'terminated' where id = $1 and status = 'active'`, [
      lease.previous_lease_id,
    ]);
    // Whatever the tenant still owed on the old lease is still owed. Left behind on a
    // terminated lease it dropped off every screen and out of the eventual exit settlement,
    // which only looks at the live lease. The invoices and the payments against them move
    // across with the tenant, as the deposit does below.
    await moveOpenInvoices(run, lease.previous_lease_id, lease.id);
    // The deposit ledger follows the tenant, not the lease, so the interest history moves
    // across with them rather than being refunded and recollected.
    await run(`update deposit_ledger set lease_id = $1 where lease_id = $2`, [lease.id, lease.previous_lease_id]);
  }
  await run(`update lease set status = 'active', activated_at = now() where id = $1`, [lease.id]);
  await run(`update unit set status = 'occupied' where id = $1`, [lease.unit_id]);
  await audit(
    {
      actorSub: actor.sub,
      actorRole: actor.role,
      action: 'lease.activated',
      entity: 'lease',
      entityId: lease.id,
      detail: { previousLeaseId: lease.previous_lease_id },
    },
    run,
  );
}

/**
 * Moves the old lease's open invoices to the renewal. A renewal starting mid-month has its own
 * invoice for that month (the old lease billed the 1st to its end date, the renewal the rest),
 * and re-pointing the old one broke unique (lease_id, period_start), so activation failed every
 * morning. The two are merged instead: the old invoice's lines and payments join the renewal's
 * invoice for that month, and the emptied old invoice is voided.
 */
async function moveOpenInvoices(run: Run, fromLeaseId: string, toLeaseId: string) {
  const clashes = await run<{ old_id: string; new_id: string; new_status: string }>(
    `select o.id as old_id, n.id as new_id, n.status as new_status
       from invoice o
       join invoice n on n.lease_id = $1 and n.period_start = o.period_start
      where o.lease_id = $2 and o.status in ('issued', 'part_paid')`,
    [toLeaseId, fromLeaseId],
  );
  for (const clash of clashes) {
    if (clash.new_status === 'void') {
      // Nothing sensible to merge into; it stays on the old lease for a person to sort out.
      logger.warn('Old lease invoice clashes with a voided renewal invoice; left in place.', {
        invoiceId: clash.old_id,
      });
      continue;
    }
    // The old lease's rent becomes a fixed line, so a later re-rate of the renewal's rent (on
    // notice) only ever touches the renewal's own days.
    await run(
      `update invoice_line set invoice_id = $1, kind = case when kind = 'rent' then 'other' else kind end
        where invoice_id = $2`,
      [clash.new_id, clash.old_id],
    );
    await run(`update payment set invoice_id = $1, lease_id = $3 where invoice_id = $2`, [
      clash.new_id,
      clash.old_id,
      toLeaseId,
    ]);
    await run(
      `update invoice n
          set total_cents = n.total_cents + o.total_cents,
              due_on = least(n.due_on, o.due_on),
              covers_from = least(coalesce(n.covers_from, n.period_start), coalesce(o.covers_from, o.period_start)),
              covers_to = greatest(n.covers_to, o.covers_to)
         from invoice o
        where n.id = $1 and o.id = $2`,
      [clash.new_id, clash.old_id],
    );
    await run(
      `update invoice
          set status = case when paid.cents >= total_cents then 'paid'
                            when paid.cents > 0 then 'part_paid' else 'issued' end
         from (select coalesce(sum(amount_cents), 0) as cents from payment where invoice_id = $1) paid
        where id = $1`,
      [clash.new_id],
    );
    await run(`update invoice set status = 'void', total_cents = 0 where id = $1`, [clash.old_id]);
  }

  await run(
    `update invoice o set lease_id = $1
      where o.lease_id = $2 and o.status in ('issued', 'part_paid')
        and not exists (select 1 from invoice n where n.lease_id = $1 and n.period_start = o.period_start)`,
    [toLeaseId, fromLeaseId],
  );
  await run(
    `update payment p set lease_id = $1
       from invoice i
      where p.invoice_id = i.id and i.lease_id = $1 and p.lease_id = $2`,
    [toLeaseId, fromLeaseId],
  );
}
