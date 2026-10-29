import { caller } from '../lib/auth';
import { query } from '../lib/db';
import { json, route } from '../lib/http';

/**
 * Everything the caller is a party to. Without this the app has no way to discover a lease id,
 * which made every lease-scoped screen unreachable.
 */
export const handler = route(async (event) => {
  const person = caller(event);
  const isLandlord = person.groups.includes('landlord');

  const rows = await query<{
    id: string;
    ref: string;
    status: string;
    start_date: string;
    end_date: string;
    monthly_rent_cents: string;
    escalation_pct: string;
    unit: string;
    tenant: string;
    deposit_balance: string;
    outstanding: string;
    open_tickets: string;
    termination_effective_on: string | null;
    renewal_status: string | null;
  }>(
    `select l.id,
            'LSE-' || lpad(l.ref_no::text, 5, '0') as ref,
            l.status, l.start_date::text, l.end_date::text,
            l.monthly_rent_cents, l.escalation_pct,
            p.name || ' ' || u.code as unit,
            a.first_name || ' ' || a.last_name as tenant,
            coalesce((select sum(case d.entry_type
                       when 'received' then d.amount_cents
                       when 'interest' then d.amount_cents
                       else -d.amount_cents end)
                        from deposit_ledger d where d.lease_id = l.id), 0)::text as deposit_balance,
            -- Each open invoice less the payments made against it. Subtracting every payment
            -- the lease ever received from only the unpaid invoices made arrears vanish as
            -- soon as any earlier invoice had been paid.
            coalesce((select sum(i.total_cents - coalesce((select sum(pay.amount_cents)
                                                            from payment pay
                                                           where pay.invoice_id = i.id), 0))
                        from invoice i
                       where i.lease_id = l.id and i.status in ('issued', 'part_paid')), 0)::text as outstanding,
            (select count(*) from ticket t
              where t.lease_id = l.id
                and t.status not in ('closed', 'cancelled'))::text as open_tickets,
            t.effective_on::text as termination_effective_on,
            r.status as renewal_status
       from lease l
       join unit u on u.id = l.unit_id
       join property p on p.id = u.property_id
       join landlord ll on ll.id = p.landlord_id
       join applicant a on a.id = l.applicant_id
       left join termination t on t.lease_id = l.id and t.status <> 'withdrawn'
       left join renewal r on r.lease_id = l.id and r.status = 'offered'
      where l.status in ('active', 'scheduled', 'out_for_signature')
        -- Any member of the landlord's team, not only the owner: agents saw an empty list.
        and (($1 and exists (select 1 from landlord_member m where m.landlord_id = ll.id and m.sub = $2)) or a.cognito_sub = $2)
      order by l.start_date desc`,
    [isLandlord, person.sub],
  );

  return json(200, {
    role: isLandlord ? 'landlord' : 'tenant',
    items: rows.map((row) => ({
      id: row.id,
      ref: row.ref,
      status: row.status,
      unit: row.unit,
      tenant: row.tenant,
      startDate: row.start_date,
      endDate: row.end_date,
      monthlyRentCents: Number(row.monthly_rent_cents),
      escalationPct: Number(row.escalation_pct),
      depositBalanceCents: Number(row.deposit_balance),
      outstandingCents: Math.max(0, Number(row.outstanding)),
      openTickets: Number(row.open_tickets),
      terminationEffectiveOn: row.termination_effective_on,
      renewalOffered: row.renewal_status === 'offered',
    })),
  });
});
