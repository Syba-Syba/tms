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
 * Withdraws a notice, before the lease has ended and before the deposit is settled: a tenant
 * who changed their mind, a landlord whose notice was a mistake. Only the party who gave it may:
 * letting either side withdraw the other's let a tenant cancel every notice a landlord served,
 * and a landlord undo a tenant's CPA s14 cancellation. A mutual notice, once the tenant has
 * confirmed it, is an agreement of both, so neither undoes it alone. A notice the landlord
 * recorded for the tenant (mutual or the tenant's) that the tenant has not confirmed stays open
 * to the tenant and to the landlord who recorded it, even on and after its end date. 'withdrawn' existed but nothing set it, and the one notice a
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
    const [termination] = await run<{
      lease_id: string;
      status: string;
      effective_on: string;
      lease_status: string;
      lapsed_renewal_ids: string[];
      cancelled_lease_id: string | null;
      initiated_by: 'tenant' | 'landlord' | 'mutual';
      awaiting_tenant: boolean;
      attested: boolean;
    }>(
      `select t.lease_id, t.status, t.effective_on::text, l.status as lease_status,
              t.lapsed_renewal_ids, t.cancelled_lease_id, t.initiated_by,
              (t.needs_tenant_confirmation and t.tenant_confirmed_at is null) as awaiting_tenant,
              t.attested_at is not null as attested
         from termination t join lease l on l.id = t.lease_id
        where t.id = $1
        for update of t, l`,
      [terminationId],
    );
    if (!termination) throw notFound('Termination');
    // A notice the landlord recorded that the tenant has not confirmed is still only the
    // landlord's entry: the landlord may undo it at any time, or a tenant who never answers
    // leaves the lease unbilled and unsettleable for good.
    const landlordUndoesOwnEntry = termination.awaiting_tenant && withdrawnBy === 'landlord';
    if (termination.initiated_by !== 'mutual' && termination.initiated_by !== withdrawnBy && !landlordUndoesOwnEntry) {
      throw forbidden('Only the party who gave this notice can withdraw it.');
    }
    // Agreed by both: the tenant may have signed elsewhere, the landlord re-let the unit.
    // One the landlord attested to is not that: the tenant never confirmed it, and withdrawing
    // is how they dispute it.
    const tenantDisputesAttested = termination.attested && withdrawnBy === 'tenant';
    if (termination.initiated_by === 'mutual' && !termination.awaiting_tenant && !tenantDisputesAttested) {
      throw conflict('Both parties agreed this end date. Undoing it needs both: record a new agreement instead.');
    }
    if (termination.status === 'withdrawn') throw conflict('This notice has already been withdrawn.');
    if (termination.status === 'settled') throw conflict('The deposit is settled, so this notice can no longer be withdrawn.');
    if (termination.lease_status !== 'active') throw conflict(`This lease is ${termination.lease_status}.`);
    // On the last day the tenant is moving out; after it the tenancy has ended. A new lease is
    // the way back then, not undoing the notice.
    // A notice the tenant never agreed to does not bind them, so the day it named passing
    // does not stop either side undoing it.
    if (today >= termination.effective_on && !termination.awaiting_tenant) {
      throw conflict(`The lease ends on ${termination.effective_on}, so the notice can only be withdrawn before then.`);
    }

    await run(`update termination set status = 'withdrawn' where id = $1`, [terminationId]);
    // Before the invoices: a revived renewal sets where this lease's billing stops.
    const renewalsRestored = await restoreRenewals(run, termination, today);
    const invoicesRestored = await restoreInvoicesAfter(run, termination.lease_id, termination.effective_on, today);
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
      renewalsRestored,
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
      renewalsRestored: result.renewalsRestored,
    },
  });

  return json(200, {
    id: terminationId,
    status: 'withdrawn',
    invoicesRestored: result.invoicesRestored,
    inspectionsCancelled: result.inspectionsCancelled,
    renewalsRestored: result.renewalsRestored,
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
async function restoreInvoicesAfter(run: Run, leaseId: string, effectiveOn: string, today: string): Promise<number> {
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
      // A trimmed month that was paid in full owes the difference from today, not from its old
      // due date: otherwise the tenant was weeks in arrears the moment the notice was withdrawn.
      `update invoice
          set total_cents = $2, covers_from = $3, covers_to = $4,
              status = case when $5::bigint >= $2 then 'paid' when $5::bigint > 0 then 'part_paid' else 'issued' end,
              due_on = case when status = 'paid' and $5::bigint < $2 then greatest(due_on, $6::date) else due_on end
        where id = $1`,
      [invoice.id, total, from, to, paid, today],
    );
    changed += 1;
  }
  return changed;
}

/**
 * Puts back what serving the notice undid, where it still stands. An offer comes back while
 * its reply date has not passed. An accepted renewal comes back with its scheduled lease while
 * that lease has not started and the unit has no other lease scheduled. Anything else stays
 * lapsed: the landlord makes a new offer.
 */
async function restoreRenewals(
  run: Run,
  termination: { lapsed_renewal_ids: string[]; cancelled_lease_id: string | null },
  today: string,
): Promise<number> {
  let restored = 0;
  if (termination.cancelled_lease_id) {
    const revived = await run<{ id: string }>(
      `update lease set status = 'scheduled'
        where id = $1 and status = 'cancelled' and start_date > $2::date
          and not exists (select 1 from lease other
                           where other.unit_id = lease.unit_id and other.status = 'scheduled')
        returning id`,
      [termination.cancelled_lease_id, today],
    );
    if (revived.length > 0) {
      const renewals = await run<{ id: string }>(
        `update renewal set status = 'accepted'
          where new_lease_id = $1 and status = 'lapsed' and id = any($2::uuid[])
          returning id`,
        [termination.cancelled_lease_id, termination.lapsed_renewal_ids],
      );
      restored += renewals.length;
    }
  }
  const offers = await run<{ id: string }>(
    `update renewal set status = 'offered'
      where id = any($1::uuid[]) and status = 'lapsed' and new_lease_id is null and respond_by >= $2::date
        and not exists (select 1 from renewal other
                         where other.lease_id = renewal.lease_id and other.status = 'offered')
      returning id`,
    [termination.lapsed_renewal_ids, today],
  );
  return restored + offers.length;
}
