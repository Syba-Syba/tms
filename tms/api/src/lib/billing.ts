import type { query } from './db';
import { billingWindow, describeWindow, rentForWindow } from '../domain/renewal';
import { dateFromIso, isoDate } from '../domain/dates';
import { logger } from './logger';

type Run = typeof query;

/**
 * Brings invoices already issued into line with a lease that now ends on `effectiveOn`.
 *
 * The invoice run issues next month's rent on the 25th. Notice served after that left the
 * full-month invoice standing, so a tenant who moved out on the 10th owed the whole month,
 * and the difference came straight off their deposit as "arrears". A month nobody occupies
 * is voided; a month partly occupied is re-rated on the days actually there.
 *
 * Runs inside the caller's transaction. An invoice with payments above its corrected total
 * is left alone and logged: money already received is reconciled by a person, not a job.
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
  }>(
    `select i.id, i.period_start::text, i.covers_from::text, i.covers_to::text, i.total_cents,
            coalesce((select sum(p.amount_cents) from payment p where p.invoice_id = i.id), 0)::text as paid,
            l.start_date::text, l.end_date::text, l.monthly_rent_cents, l.escalation_pct
       from invoice i
       join lease l on l.id = i.lease_id
      where i.lease_id = $1
        and i.status in ('issued', 'part_paid')
        and coalesce(i.covers_to, (i.period_start + interval '1 month' - interval '1 day')::date) > $2::date
      order by i.period_start`,
    [leaseId, effectiveOn],
  );

  let changed = 0;
  for (const invoice of invoices) {
    const window = billingWindow({
      periodStart: dateFromIso(invoice.period_start),
      leaseStart: dateFromIso(invoice.start_date),
      leaseEnd: dateFromIso(invoice.end_date),
      terminationEffectiveOn: dateFromIso(effectiveOn),
    });
    const paid = Number(invoice.paid);

    if (!window) {
      if (paid > 0) {
        logger.warn('Invoice covers a month after the lease ends but has payments; left for review.', {
          invoiceId: invoice.id,
        });
        continue;
      }
      await run(`update invoice set status = 'void' where id = $1`, [invoice.id]);
      changed += 1;
      continue;
    }

    const rent = rentForWindow({
      baseRentCents: Number(invoice.monthly_rent_cents),
      escalationPct: Number(invoice.escalation_pct),
      leaseStart: dateFromIso(invoice.start_date),
      window,
    });
    if (rent === Number(invoice.total_cents)) continue;
    if (paid > rent) {
      logger.warn('Invoice is paid above its re-rated total; left for review.', { invoiceId: invoice.id });
      continue;
    }

    // Rent is the one line the run writes; utilities and other charges stand as entered.
    const [rentLine] = await run<{ id: string; amount_cents: string }>(
      `select id, amount_cents from invoice_line where invoice_id = $1 and kind = 'rent' order by id limit 1`,
      [invoice.id],
    );
    const otherLines = Number(invoice.total_cents) - Number(rentLine?.amount_cents ?? invoice.total_cents);
    const total = rent + otherLines;
    if (rentLine) {
      await run(`update invoice_line set amount_cents = $2, description = $3 where id = $1`, [
        rentLine.id,
        rent,
        `Rent · ${invoice.period_start.slice(0, 7)}${describeWindow(window)}`,
      ]);
    }
    await run(
      `update invoice
          set total_cents = $2, covers_from = $3, covers_to = $4,
              status = case when $5::bigint >= $2 then 'paid' when $5::bigint > 0 then 'part_paid' else 'issued' end
        where id = $1`,
      [invoice.id, total, isoDate(window.from), isoDate(window.to), paid],
    );
    changed += 1;
  }
  return changed;
}
