import { query, withTransaction } from '../lib/db';
import { zar } from '../domain/money';
import { billingWindow, describeWindow, rentForWindow } from '../domain/renewal';
import { notify } from '../lib/notify';

/** EventBridge, 06:00 on the 25th: issue next month's rent invoices for every active lease.
    Idempotent through the (lease_id, period_start) unique key, so a re-run cannot double bill. */
export const handler = async () => {
  const now = new Date();
  const period = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const periodIso = period.toISOString().slice(0, 10);

  const leases = await query<{
    id: string;
    start_date: string;
    end_date: string;
    monthly_rent_cents: string;
    escalation_pct: string;
    termination_effective_on: string | null;
    unit_code: string;
    lease_ref: string;
    unit_label: string;
    tenant_sub: string | null;
    tenant_email: string;
    tenant_phone: string;
  }>(
    // A lease stays 'active' until the deposit is settled, which can be weeks after the
    // tenant moves out. Without the termination join this run bills months nobody lived there,
    // and those invoices then come straight back off the deposit as arrears.
    `select l.id, l.start_date::text, l.end_date::text, l.monthly_rent_cents, l.escalation_pct,
            t.effective_on::text as termination_effective_on,
            u.code as unit_code,
            'LSE-' || lpad(l.ref_no::text, 5, '0') as lease_ref,
            p.name || ' ' || u.code as unit_label,
            a.cognito_sub as tenant_sub, a.email as tenant_email, a.phone as tenant_phone
       from lease l
       join unit u on u.id = l.unit_id
       join property p on p.id = u.property_id
       join applicant a on a.id = l.applicant_id
       left join termination t on t.lease_id = l.id and t.status <> 'withdrawn'
      where l.status = 'active'
        and l.start_date <= ($1::date + interval '1 month' - interval '1 day')
        and least(l.end_date, coalesce(t.effective_on, l.end_date)) >= $1::date`,
    [periodIso],
  );

  let issued = 0;
  for (const lease of leases) {
    // A part month is charged on the days actually occupied, counted against the real length
    // of that month. A mid-month start used to be billed nothing and a mid-month end a full
    // month, and that overcharge came back off the deposit as arrears.
    const window = billingWindow({
      periodStart: period,
      leaseStart: new Date(lease.start_date),
      leaseEnd: new Date(lease.end_date),
      terminationEffectiveOn: lease.termination_effective_on
        ? new Date(lease.termination_effective_on)
        : null,
    });
    if (!window) continue;
    const rent = rentForWindow({
      baseRentCents: Number(lease.monthly_rent_cents),
      escalationPct: Number(lease.escalation_pct),
      leaseStart: new Date(lease.start_date),
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
      console.error('Invoice failed for lease', lease.id, error);
    }
  }
  console.log(JSON.stringify({ message: 'Invoice run complete.', period: periodIso, issued }));
  return { issued };
};
