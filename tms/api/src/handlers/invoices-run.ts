import { query, withTransaction } from '../lib/db';
import { FULLY_SIGNED_SQL } from '../lib/activation';
import { billableUntil, RENEWAL_STARTS_SQL } from '../lib/billing';
import { zar } from '../domain/money';
import { billingWindow, describeWindow, rentForWindow } from '../domain/renewal';
import { dateFromIso, nextMonthStart, sastDayOfMonth, sastMonthStart, sastToday } from '../domain/dates';
import { notify } from '../lib/notify';
import { noticeInForceSql } from '../domain/termination';
import { jobLogger } from '../lib/logger';

const log = jobLogger('invoices-run');

/** Next month's rent goes out on the 25th. */
export const ISSUE_FROM_DAY = 25;

/**
 * The months this run bills on a given day: always the current one, and from the 25th the next
 * one too. The run is idempotent through the (lease_id, period_start) unique key, so running
 * it daily costs nothing and catches what a single run on the 25th missed: a lease activated
 * on the 28th had no invoice for its first month, and neither did the first month of any
 * renewal, because the renewal lease is still 'scheduled' on the 25th before it starts.
 */
export function periodsDue(now: Date = new Date()): string[] {
  const current = sastMonthStart(now);
  return sastDayOfMonth(now) >= ISSUE_FROM_DAY ? [current, nextMonthStart(current)] : [current];
}

/**
 * Months before the current one that a live lease has no invoice for. The daily run only bills
 * the current month (and the next from the 25th), so a lease that started in a month that had
 * ended before it was activated (starts 28 October, signed 2 November) never had those days
 * billed. Each such month is billed like any other; the run's own checks (the lease's billable
 * window, notice, a renewal's previous lease) still decide whether there is anything to bill.
 * An imported lease is billed in Threshold only from the month it was brought in; from then on
 * a month it missed (a notice that stood for a while and was withdrawn) is caught up like any other.
 */
export async function missedPeriods(current: string): Promise<string[]> {
  const rows = await query<{ period: string }>(
    `select distinct m::date::text as period
       from lease l
       cross join lateral generate_series(
         date_trunc('month', case when l.source = 'import'
           then greatest(l.start_date::timestamp, (coalesce(l.activated_at, now()) at time zone 'Africa/Johannesburg'))
           else l.start_date::timestamp end),
         $1::timestamp - interval '1 month', interval '1 month') m
      where l.status = 'active'
        and not exists (select 1 from invoice i where i.lease_id = l.id and i.period_start = m::date)
      order by 1`,
    [current],
  );
  return rows.map((row) => row.period);
}

interface BillableLease {
  id: string;
  status: string;
  start_date: string;
  end_date: string;
  monthly_rent_cents: string;
  escalation_pct: string;
  escalates_from: string | null;
  termination_effective_on: string | null;
  renewal_starts_on: string | null;
  unit_code: string;
  lease_ref: string;
  unit_label: string;
  tenant_sub: string | null;
  tenant_email: string;
  tenant_phone: string;
  activated_on: string | null;
}

export const handler = async (input?: { periods?: string[]; now?: Date }) => {
  const periods = input?.periods
    ?? [...new Set([...(await missedPeriods(sastMonthStart(input?.now))), ...periodsDue(input?.now)])];
  let issued = 0;
  let considered = 0;

  const currentMonth = sastMonthStart(input?.now);
  for (const periodIso of periods) {
    const period = dateFromIso(periodIso);
    const catchUpDue = periodIso < currentMonth ? sastToday(input?.now) : null;
    const leases = await query<BillableLease>(
      // A lease stays 'active' until the deposit is settled, which can be weeks after the
      // tenant moves out. Without the termination join this run bills months nobody lived
      // there, and those invoices then come straight back off the deposit as arrears.
      // 'scheduled' is a renewal that has not started yet. Once both parties have signed it,
      // its first month is billed here like any other, because by the time it is active the
      // 25th has passed. Unsigned, it bills nothing, and the current lease carries on month to
      // month (RHA s5(5)) and is billed as such. A renewal signed late then skips the months
      // the old lease already billed, so nobody pays twice for the same days.
      `select l.id, l.status, l.start_date::text, l.end_date::text, l.monthly_rent_cents, l.escalation_pct,
              l.escalates_from::text,
              t.effective_on::text as termination_effective_on,
              ${RENEWAL_STARTS_SQL('l')} as renewal_starts_on,
              u.code as unit_code,
              'LSE-' || lpad(l.ref_no::text, 5, '0') as lease_ref,
              p.name || ' ' || u.code as unit_label,
              -- An imported tenant has no sign-in yet, and is told by email all the same.
              coalesce(a.cognito_sub, 'applicant:' || a.id) as tenant_sub, a.email as tenant_email, a.phone as tenant_phone,
              (l.activated_at at time zone 'Africa/Johannesburg')::date::text as activated_on
         from lease l
         join unit u on u.id = l.unit_id
         join property p on p.id = u.property_id
         join applicant a on a.id = l.applicant_id
         -- A notice the tenant has not confirmed does not stop the rent: it is the landlord's
         -- entry only, and a tenant who never answered left the lease unbilled for good.
         left join termination t on t.lease_id = l.id and t.status <> 'withdrawn' and ${noticeInForceSql('t')}
        where (l.status = 'active' or (l.status = 'scheduled' and ${FULLY_SIGNED_SQL('l')}))
          and not exists (select 1 from invoice pi
                           where pi.lease_id = l.previous_lease_id and pi.period_start = $1::date
                             and pi.status <> 'void')
          and l.start_date <= ($1::date + interval '1 month' - interval '1 day')
          and (t.effective_on is null or t.effective_on >= $1::date)
          -- An imported lease's months before it was brought in were billed elsewhere.
          and (l.source <> 'import'
               or $1::date >= date_trunc('month', coalesce(l.activated_at, now()) at time zone 'Africa/Johannesburg')::date)`,
      [periodIso],
    );
    considered += leases.length;

    for (const lease of leases) {
      // Holding over bills month to month; notice or a signed renewal sets the last day.
      const leaseEnd = billableUntil({
        endDate: lease.end_date,
        terminationEffectiveOn: lease.termination_effective_on,
        renewalStartsOn: lease.renewal_starts_on,
      });
      // A part month is charged on the days actually occupied, counted against the real
      // length of that month. A mid-month start used to be billed nothing and a mid-month
      // end a full month, and that overcharge came back off the deposit as arrears.
      const window = billingWindow({
        periodStart: period,
        leaseStart: dateFromIso(lease.start_date),
        leaseEnd,
        terminationEffectiveOn: lease.termination_effective_on
          ? dateFromIso(lease.termination_effective_on)
          : null,
      });
      if (!window) continue;
      const rent = rentForWindow({
        baseRentCents: Number(lease.monthly_rent_cents),
        escalationPct: Number(lease.escalation_pct),
        // An imported lease states its current rent, so escalation counts from when that took effect.
        leaseStart: dateFromIso(lease.escalates_from ?? lease.start_date),
        window,
      });
      try {
        const created = await withTransaction(async (run) => {
          // Adding a charge locks the lease. Without the same lock here, a charge added between
          // the pending_charge sweep below and this commit found no invoice yet, went into
          // pending_charge after the sweep, and was never billed.
          await run('select id from lease where id = $1 for update', [lease.id]);
          // Rent for a month that began before the lease went live (signed after its start
          // date) falls due on the day it went live, not on the 1st. Dated the 1st, the
          // invoice was born weeks overdue and the next arrears run sent the final reminder.
          // A month billed late (catching up after missed runs) falls due today, for the same reason.
          const [invoice] = await run<{ id: string; due_on: string }>(
            `insert into invoice (lease_id, period_start, due_on, total_cents, covers_from, covers_to)
             values ($1, $2, greatest($2::date, coalesce($6::date, $2::date), coalesce($7::date, $2::date)), $3, $4, $5)
             on conflict (lease_id, period_start) do nothing
             returning id, due_on::text`,
            [lease.id, periodIso, rent, window.from, window.to, lease.activated_on, catchUpDue],
          );
          if (!invoice) return null;
          await run(
            `insert into invoice_line (invoice_id, kind, description, amount_cents)
             values ($1, 'rent', $2, $3)`,
            [
              invoice.id,
              `Rent · ${lease.unit_code} · ${periodIso.slice(0, 7)}${describeWindow(window)}`,
              rent,
            ],
          );
          // Charges the landlord added for this month before it was billed: water, levies.
          const extras = await run<{ kind: string; description: string; amount_cents: string }>(
            `delete from pending_charge where lease_id = $1 and period_start = $2
             returning kind, description, amount_cents::text`,
            [lease.id, periodIso],
          );
          for (const extra of extras) {
            await run(
              `insert into invoice_line (invoice_id, kind, description, amount_cents) values ($1, $2, $3, $4)`,
              [invoice.id, extra.kind, extra.description, extra.amount_cents],
            );
          }
          if (extras.length > 0) {
            await run(
              'update invoice set total_cents = total_cents + $2 where id = $1',
              [invoice.id, extras.reduce((sum, extra) => sum + Number(extra.amount_cents), 0)],
            );
          }
          return { dueOn: invoice.due_on, totalCents: rent + extras.reduce((sum, extra) => sum + Number(extra.amount_cents), 0) };
        });
        if (!created) continue;
        issued += 1;
        if (lease.tenant_sub) {
          await notify({
            leaseId: lease.id,
            to: { sub: lease.tenant_sub, email: lease.tenant_email, phone: lease.tenant_phone },
            kind: 'invoice_issued',
            dedupeKey: `invoice_issued:${lease.id}:${periodIso}`,
            data: {
              period: periodIso.slice(0, 7),
              amount: zar(created.totalCents),
              dueOn: created.dueOn,
              reference: lease.lease_ref,
              unit: lease.unit_label,
            },
          });
        }
      } catch (error) {
        log.error('Invoice failed for a lease.', { leaseId: lease.id, period: periodIso, error });
      }
    }
  }
  log.info('Invoice run complete.', { periods, issued, considered });
  return { issued };
};
