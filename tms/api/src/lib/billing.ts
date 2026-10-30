import type { query } from './db';
import { FULLY_SIGNED_SQL } from './activation';
import { billingWindow, describeWindow, rentForWindow } from '../domain/renewal';
import { dateFromIso, isoDate } from '../domain/dates';
import { logger } from './logger';

type Run = typeof query;

/** A date past any lease, for a tenancy with no end in sight. */
const OPEN_ENDED = new Date(8640000000000000);

/** The start date of the fully signed renewal that takes over from this lease, if any. */
export const RENEWAL_STARTS_SQL = (alias: string) =>
  `(select min(n.start_date)::text from lease n where n.previous_lease_id = ${alias}.id
     and n.status in ('scheduled', 'active') and ${FULLY_SIGNED_SQL('n')})`;

/**
 * The last day a lease can be billed to, before any notice caps it.
 *
 * A fixed term that ran out with no notice served and no renewal signed is a tenant holding
 * over: the Rental Housing Act continues the lease month to month on the same terms, so rent
 * is still due. A signed renewal takes over on its start date, which for a holdover is later
 * than the day after the end date, and the months between are still billed. Notice served on a
 * lease, holding over or not, ends it on its effective date: capping at the end date as well
 * left a holdover tenant's last weeks unbilled, or voided them once already billed.
 */
export function billableUntil(lease: {
  endDate: string;
  terminationEffectiveOn: string | null;
  renewalStartsOn: string | null;
}): Date {
  if (lease.renewalStartsOn) return new Date(dateFromIso(lease.renewalStartsOn).getTime() - 86400000);
  if (!lease.terminationEffectiveOn) return OPEN_ENDED;
  const end = dateFromIso(lease.endDate);
  const effective = dateFromIso(lease.terminationEffectiveOn);
  return effective > end ? effective : end;
}

/**
 * Brings invoices already issued into line with a lease that now ends on `effectiveOn`.
 *
 * The invoice run issues next month's rent on the 25th. Notice served after that left the
 * full-month invoice standing, so a tenant who moved out on the 10th owed the whole month,
 * and the difference came straight off their deposit as "arrears". A month nobody occupies
 * is voided; a month partly occupied is re-rated on the days actually there.
 *
 * Paid invoices are re-rated too. Rent paid for days after the tenant leaves stays recorded
 * against the invoice, now above its total, and that excess is the tenant's credit at
 * settlement; it is logged so a person sees it. Runs inside the caller's transaction.
 */
export async function trimInvoicesAfter(run: Run, leaseId: string, effectiveOn: string): Promise<number> {
  const invoices = await run<{
    id: string;
    period_start: string;
    covers_from: string | null;
    covers_to: string | null;
    total_cents: string;
    paid: string;
    start_date: string;
    end_date: string;
    monthly_rent_cents: string;
    escalation_pct: string;
    escalates_from: string | null;
    renewal_starts_on: string | null;
  }>(
    `select i.id, i.period_start::text, i.covers_from::text, i.covers_to::text, i.total_cents,
            coalesce((select sum(p.amount_cents) from payment p where p.invoice_id = i.id), 0)::text as paid,
            l.start_date::text, l.end_date::text, l.monthly_rent_cents, l.escalation_pct,
            l.escalates_from::text, ${RENEWAL_STARTS_SQL('l')} as renewal_starts_on
       from invoice i
       join lease l on l.id = i.lease_id
      where i.lease_id = $1
        and i.status in ('issued', 'part_paid', 'paid')
        and coalesce(i.covers_to, (i.period_start + interval '1 month' - interval '1 day')::date) > $2::date
      order by i.period_start`,
    [leaseId, effectiveOn],
  );

  let changed = 0;
  for (const invoice of invoices) {
    const window = billingWindow({
      periodStart: dateFromIso(invoice.period_start),
      leaseStart: dateFromIso(invoice.start_date),
      leaseEnd: billableUntil({
        endDate: invoice.end_date,
        terminationEffectiveOn: effectiveOn,
        renewalStartsOn: invoice.renewal_starts_on,
      }),
      terminationEffectiveOn: dateFromIso(effectiveOn),
    });
    const paid = Number(invoice.paid);

    // Rent is the one line the run writes; utilities and other charges stand as entered.
    const [rentLine] = await run<{ id: string; amount_cents: string }>(
      `select id, amount_cents from invoice_line where invoice_id = $1 and kind = 'rent' order by id limit 1`,
      [invoice.id],
    );
    const otherLines = Number(invoice.total_cents) - Number(rentLine?.amount_cents ?? invoice.total_cents);
    const rent = window
      ? rentForWindow({
          baseRentCents: Number(invoice.monthly_rent_cents),
          escalationPct: Number(invoice.escalation_pct),
          // Same anchor as the invoice run. An imported lease's rent already includes the years
          // before it joined, so counting escalation from the original start compounded them again.
          leaseStart: dateFromIso(invoice.escalates_from ?? invoice.start_date),
          window,
        })
      : 0;
    const total = rent + otherLines;

    // A month nobody occupies and nobody paid for goes entirely, unless it carries other
    // charges. Those are often the last occupied month's water, put on this invoice because
    // that month's was already due, and voiding the invoice lost them. The rent comes off and
    // the charges stand, as on a paid month.
    if (!window && paid === 0 && otherLines === 0) {
      await run(`update invoice set status = 'void' where id = $1`, [invoice.id]);
      changed += 1;
      continue;
    }
    if (total === Number(invoice.total_cents)) continue;
    if (paid > total) {
      logger.warn('Invoice is paid above its re-rated total; the excess is a credit at settlement.', {
        invoiceId: invoice.id,
        creditCents: paid - total,
      });
    }

    if (rentLine) {
      await run(`update invoice_line set amount_cents = $2, description = $3 where id = $1`, [
        rentLine.id,
        rent,
        window
          ? `Rent · ${invoice.period_start.slice(0, 7)}${describeWindow(window)}`
          : `Rent · ${invoice.period_start.slice(0, 7)} (not occupied)`,
      ]);
    }
    await run(
      `update invoice
          set total_cents = $2, covers_from = $3, covers_to = $4,
              status = case when $5::bigint >= $2 then 'paid' when $5::bigint > 0 then 'part_paid' else 'issued' end
        where id = $1`,
      [
        invoice.id,
        total,
        window ? isoDate(window.from) : invoice.covers_from,
        window ? isoDate(window.to) : invoice.covers_to,
        paid,
      ],
    );
    changed += 1;
  }
  return changed;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthLabel = (month: string) => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

/**
 * Puts charges waiting for a month after `lastDay` onto the lease's last invoice, as adding a
 * charge to an ending lease does. Once a lease ends the run never bills those months again, so
 * water added for next month before notice was served waited in pending_charge for ever,
 * billed to nobody and missing from the deposit settlement. Each keeps its own month in the
 * description. Runs inside the caller's transaction; returns how many charges moved.
 */
export async function movePendingChargesPast(run: Run, leaseId: string, lastDay: string): Promise<number> {
  const charges = await run<{ id: string; period_start: string; kind: string; description: string; amount_cents: string }>(
    `select id, period_start::text, kind, description, amount_cents::text from pending_charge
      where lease_id = $1 and period_start > date_trunc('month', $2::date)
      order by period_start, created_at
      for update`,
    [leaseId, lastDay],
  );
  if (charges.length === 0) return 0;
  const [last] = await run<{ id: string; period_start: string }>(
    `select id, period_start::text from invoice
      where lease_id = $1 and status <> 'void' order by period_start desc limit 1 for update`,
    [leaseId],
  );
  if (!last) {
    logger.warn('Charges after the last month of a lease have no invoice to go on; left pending.', { leaseId });
    return 0;
  }
  for (const charge of charges) {
    const description = charge.period_start.slice(0, 7) === last.period_start.slice(0, 7)
      ? charge.description
      : `${charge.description} (${monthLabel(charge.period_start)})`;
    await run(`insert into invoice_line (invoice_id, kind, description, amount_cents) values ($1, $2, $3, $4)`, [
      last.id,
      charge.kind,
      description,
      charge.amount_cents,
    ]);
    await run('delete from pending_charge where id = $1', [charge.id]);
  }
  await addToInvoice(run, last.id, charges.reduce((sum, charge) => sum + Number(charge.amount_cents), 0));
  return charges.length;
}

/** Moves an invoice's total by `deltaCents` and resets its status from what has been paid. */
async function addToInvoice(run: Run, invoiceId: string, deltaCents: number): Promise<void> {
  await run(
    `update invoice i
        set total_cents = i.total_cents + $2,
            status = case when paid.cents >= i.total_cents + $2 then 'paid'
                          when paid.cents > 0 then 'part_paid' else 'issued' end
       from (select coalesce(sum(amount_cents), 0) as cents from payment where invoice_id = $1) paid
      where i.id = $1`,
    [invoiceId, deltaCents],
  );
}
