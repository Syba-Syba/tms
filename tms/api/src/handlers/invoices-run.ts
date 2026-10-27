import { query, withTransaction } from '../lib/db';
import { zar } from '../domain/money';
import { billingWindow, describeWindow, rentForWindow } from '../domain/renewal';
import { dateFromIso, nextMonthStart, sastDayOfMonth, sastMonthStart } from '../domain/dates';
import { notify } from '../lib/notify';
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

interface BillableLease {
  id: string;
  status: string;
  start_date: string;
  end_date: string;
  monthly_rent_cents: string;
  escalation_pct: string;
  termination_effective_on: string | null;
  renewed: boolean;
  unit_code: string;
  lease_ref: string;
  unit_label: string;
  tenant_sub: string | null;
  tenant_email: string;
  tenant_phone: string;
}

export const handler = async (input?: { periods?: string[] }) => {
  const periods = input?.periods ?? periodsDue();
  let issued = 0;
  let considered = 0;

  for (const periodIso of periods) {
    const period = dateFromIso(periodIso);
    const leases = await query<BillableLease>(
      // A lease stays 'active' until the deposit is settled, which can be weeks after the
      // tenant moves out. Without the termination join this run bills months nobody lived
      // there, and those invoices then come straight back off the deposit as arrears.
      // 'scheduled' is a signed renewal that has not started yet; its first month is billed
      // here like any other, because by the time it is active the 25th has passed.
      `select l.id, l.status, l.start_date::text, l.end_date::text, l.monthly_rent_cents, l.escalation_pct,
              t.effective_on::text as termination_effective_on,
              exists (select 1 from lease n where n.previous_lease_id = l.id
                        and n.status in ('scheduled', 'active')) as renewed,
              u.code as unit_code,
              'LSE-' || lpad(l.ref_no::text, 5, '0') as lease_ref,
              p.name || ' ' || u.code as unit_label,
              a.cognito_sub as tenant_sub, a.email as tenant_email, a.phone as tenant_phone
         from lease l
         join unit u on u.id = l.unit_id
         join property p on p.id = u.property_id
         join applicant a on a.id = l.applicant_id
         left join termination t on t.lease_id = l.id and t.status <> 'withdrawn'
        where l.status in ('active', 'scheduled')
          and l.start_date <= ($1::date + interval '1 month' - interval '1 day')
          and (t.effective_on is null or t.effective_on >= $1::date)`,
      [periodIso],
    );
    considered += leases.length;

    for (const lease of leases) {
      // A fixed term that ran out with no notice served and no renewal signed is a tenant
      // holding over: the Rental Housing Act continues the lease month to month on the same
      // terms, so rent is still due. The end date only caps billing once notice is served
      // or a renewal takes over, which is when the tenancy really ends on that day.
      const openEnded = !lease.termination_effective_on && !lease.renewed;
      const leaseEnd = openEnded ? new Date(8640000000000000) : dateFromIso(lease.end_date);
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
        leaseStart: dateFromIso(lease.start_date),
        window,
      });
      try {
        const created = await withTransaction(async (run) => {
          const [invoice] = await run<{ id: string }>(
            `insert into invoice (lease_id, period_start, due_on, total_cents, covers_from, covers_to)
             values ($1, $2, $2, $3, $4, $5)
             on conflict (lease_id, period_start) do nothing
             returning id`,
            [lease.id, periodIso, rent, window.from, window.to],
          );
          if (!invoice) return false;
          await run(
            `insert into invoice_line (invoice_id, kind, description, amount_cents)
             values ($1, 'rent', $2, $3)`,
            [
              invoice.id,
              `Rent · ${lease.unit_code} · ${periodIso.slice(0, 7)}${describeWindow(window)}`,
              rent,
            ],
          );
          return true;
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
              amount: zar(rent),
              dueOn: periodIso,
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
