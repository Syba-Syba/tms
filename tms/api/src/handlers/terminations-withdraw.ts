import { requireLeaseAccessVia } from '../lib/access';
import { audit } from '../lib/audit';
import { query, withTransaction } from '../lib/db';
import { badRequest, conflict, forbidden, json, notFound, route } from '../lib/http';
import { billableUntil, RENEWAL_STARTS_SQL } from '../lib/billing';
import { billingWindow, describeWindow, rentForWindow } from '../domain/renewal';
import { dateFromIso, isoDate, sastToday } from '../domain/dates';
import { notify } from '../lib/notify';
import { leaseParties } from '../lib/lease-parties';

type Run = typeof query;

/**
 * Withdraws a notice. Either party may, before the lease has ended and before the deposit is
 * settled: a tenant who changed their mind, a landlord whose notice was a mistake, a notice
 * recorded on the wrong lease. 'withdrawn' existed but nothing set it, and the one notice a
 * lease could hold blocked serving a corrected one. The lease carries on as if notice had never
 * been served, so what serving changed is put back: the invoices it trimmed are re-rated to
 * the full months the invoice run would have billed, and an exit inspection still booked for
 * the old date is cancelled. The other party is told.
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
  if (!access.isLandlord && !access.isTenant) throw forbidden('Only the landlord or the tenant withdraws a notice.');
  const withdrawnBy: 'landlord' | 'tenant' = access.isLandlord ? 'landlord' : 'tenant';
  const today = sastToday();

  const result = await withTransaction(async (run) => {
    const [termination] = await run<{ lease_id: string; status: string; effective_on: string; lease_status: string }>(
      `select t.lease_id, t.status, t.effective_on::text, l.status as lease_status
         from termination t join lease l on l.id = t.lease_id
        where t.id = $1
        for update of t, l`,
      [terminationId],
    );
    if (!termination) throw notFound('Termination');
    if (termination.status === 'withdrawn') throw conflict('This notice has already been withdrawn.');
    if (termination.status === 'settled') throw conflict('The deposit is settled, so this notice can no longer be withdrawn.');
    if (termination.lease_status !== 'active') throw conflict(`This lease is ${termination.lease_status}.`);
    // On the last day the tenant is moving out; after it the tenancy has ended. A new lease is
    // the way back then, not undoing the notice.
    if (today >= termination.effective_on) {
      throw conflict(`The lease ends on ${termination.effective_on}, so the notice can only be withdrawn before then.`);
    }

    await run(`update termination set status = 'withdrawn' where id = $1`, [terminationId]);
    const invoicesRestored = await restoreInvoicesAfter(run, termination.lease_id, termination.effective_on);
    // An exit inspection booked for the old end date would otherwise be reminded and held.
    const inspections = await run<{ id: string }>(
      `update inspection set status = 'missed'
        where lease_id = $1 and kind = 'outgoing' and status in ('in_progress', 'awaiting_signatures')
        returning id`,
      [termination.lease_id],
    );
    return {
      leaseId: termination.lease_id,
      effectiveOn: termination.effective_on,
      invoicesRestored,
      inspectionsCancelled: inspections.length,
    };
  });

  const parties = await leaseParties(result.leaseId);
  if (parties) {
    const data = { unit: parties.unit, effectiveOn: result.effectiveOn, withdrawnBy };
    if (withdrawnBy === 'landlord') {
      await notify({
        leaseId: result.leaseId,
        to: { sub: parties.tenantSub, email: parties.tenantEmail, phone: parties.tenantPhone },
        kind: 'notice_withdrawn',
        dedupeKey: `notice_withdrawn:${terminationId}:tenant`,
        data,
      });
    } else if (parties.landlordSub) {
      await notify({
        leaseId: result.leaseId,
        to: { sub: parties.landlordSub, email: parties.landlordEmail },
        kind: 'notice_withdrawn',
        dedupeKey: `notice_withdrawn:${terminationId}:landlord`,
        data,
      });
    }
  }

  await audit({
    actorSub: access.person.sub,
    actorRole: withdrawnBy,
    action: 'termination.withdrawn',
    entity: 'termination',
    entityId: terminationId,
    detail: {
      effectiveOn: result.effectiveOn,
      invoicesRestored: result.invoicesRestored,
      inspectionsCancelled: result.inspectionsCancelled,
    },
  });

  return json(200, {
    id: terminationId,
    status: 'withdrawn',
    invoicesRestored: result.invoicesRestored,
    inspectionsCancelled: result.inspectionsCancelled,
  });
});

/**
 * Undoes trimInvoicesAfter for a notice that no longer stands. Every invoice from the month the
 * notice ended the lease in onwards is re-rated as the invoice run rates it with no notice:
 * a month the trim voided comes back (the run cannot re-issue it, the (lease, period) key is
 * taken by the void row), and a month it cut short is billed in full again. Only invoices the
 * trim could have voided are revived: those voided with their total left in place. A renewal
 * takeover voids by zeroing the total, and those stay void. Other charges on an invoice stand
 * as entered. Returns how many invoices changed.
 */
async function restoreInvoicesAfter(run: Run, leaseId: string, effectiveOn: string): Promise<number> {
  const invoices = await run<{
    id: string;
    period_start: string;
    status: string;
    total_cents: string;
    covers_from: string | null;
    covers_to: string | null;
    paid: string;
    start_date: string;
    end_date: string;
    monthly_rent_cents: string;
    escalation_pct: string;
    escalates_from: string | null;
    renewal_starts_on: string | null;
    unit_code: string;
  }>(
    `select i.id, i.period_start::text, i.status, i.total_cents::text, i.covers_from::text, i.covers_to::text,
            coalesce((select sum(p.amount_cents) from payment p where p.invoice_id = i.id), 0)::text as paid,
            l.start_date::text, l.end_date::text, l.monthly_rent_cents, l.escalation_pct,
            l.escalates_from::text, ${RENEWAL_STARTS_SQL('l')} as renewal_starts_on, u.code as unit_code
       from invoice i
       join lease l on l.id = i.lease_id
       join unit u on u.id = l.unit_id
      where i.lease_id = $1
        and i.period_start >= date_trunc('month', $2::date)
        and (i.status in ('issued', 'part_paid', 'paid') or (i.status = 'void' and i.total_cents > 0))
      order by i.period_start
      for update of i`,
    [leaseId, effectiveOn],
  );

  let changed = 0;
  for (const invoice of invoices) {
    const window = billingWindow({
      periodStart: dateFromIso(invoice.period_start),
      leaseStart: dateFromIso(invoice.start_date),
      leaseEnd: billableUntil({
        endDate: invoice.end_date,
        terminationEffectiveOn: null,
        renewalStartsOn: invoice.renewal_starts_on,
      }),
      terminationEffectiveOn: null,
    });
    // A month the lease would not have been billed for anyway stays as it is.
    if (!window) continue;
    const rent = rentForWindow({
      baseRentCents: Number(invoice.monthly_rent_cents),
      escalationPct: Number(invoice.escalation_pct),
      leaseStart: dateFromIso(invoice.escalates_from ?? invoice.start_date),
      window,
    });
    const [rentLine] = await run<{ id: string; amount_cents: string }>(
      `select id, amount_cents from invoice_line where invoice_id = $1 and kind = 'rent' order by id limit 1`,
      [invoice.id],
    );
    // Rent is the one line the run writes; utilities and other charges stand as entered.
    const otherLines = Number(invoice.total_cents) - Number(rentLine?.amount_cents ?? invoice.total_cents);
    const total = rent + otherLines;
    const from = isoDate(window.from);
    const to = isoDate(window.to);
    if (
      invoice.status !== 'void' &&
      total === Number(invoice.total_cents) &&
      invoice.covers_from === from &&
      invoice.covers_to === to
    ) {
      continue;
    }

    if (rentLine) {
      await run(`update invoice_line set amount_cents = $2, description = $3 where id = $1`, [
        rentLine.id,
        rent,
        `Rent · ${invoice.unit_code} · ${invoice.period_start.slice(0, 7)}${describeWindow(window)}`,
      ]);
    } else {
      await run(`insert into invoice_line (invoice_id, kind, description, amount_cents) values ($1, 'rent', $2, $3)`, [
        invoice.id,
        `Rent · ${invoice.unit_code} · ${invoice.period_start.slice(0, 7)}${describeWindow(window)}`,
        rent,
      ]);
    }
    const paid = Number(invoice.paid);
    await run(
      `update invoice
          set total_cents = $2, covers_from = $3, covers_to = $4,
              status = case when $5::bigint >= $2 then 'paid' when $5::bigint > 0 then 'part_paid' else 'issued' end
        where id = $1`,
      [invoice.id, total, from, to, paid],
    );
    changed += 1;
  }
  return changed;
}
