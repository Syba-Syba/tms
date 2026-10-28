import { query } from '../lib/db';
import { notify } from '../lib/notify';
import { zar } from '../domain/money';
import { jobLogger } from '../lib/logger';
import { sastToday } from '../domain/dates';

const log = jobLogger('notifications-sweep');

const days = (from: string, to: Date) =>
  Math.floor((to.getTime() - new Date(from).getTime()) / 86400000);

/**
 * Runs every morning. Everything here is time-based rather than event-based, so nothing else
 * would ever raise it. Each notification carries a dedupe key, which is why running this twice
 * in a day is harmless.
 */
export const handler = async () => {
  // The South African day, not UTC or the database's zone: between midnight and 02:00 SAST
  // those still say yesterday, and the reminders would go out a day late.
  const now = new Date();
  const today = sastToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`Bad date ${today}`);
  const sqlToday = `'${today}'::date`;
  const counts = { overdueRent: 0, slaSoon: 0, slaBreached: 0, inspections: 0, refunds: 0,
                   leaseEnding: 0, renewalsExpiring: 0, renewalsLapsed: 0 };

  /* Rent that has gone unpaid. Chased on day 3, then weekly, rather than every morning. */
  const overdue = await query<{
    lease_id: string; invoice_id: string; period: string; due_on: string;
    outstanding: string; sub: string; email: string; phone: string; unit: string; lease_ref: string;
  }>(
    `select i.lease_id, i.id as invoice_id, to_char(i.period_start, 'FMMonth YYYY') as period,
            i.due_on::text, (i.total_cents - coalesce((
              select sum(p.amount_cents) from payment p where p.invoice_id = i.id), 0))::text as outstanding,
            a.cognito_sub as sub, a.email, a.phone,
            pr.name || ' ' || u.code as unit,
            'LSE-' || lpad(l.ref_no::text, 5, '0') as lease_ref
       from invoice i
       join lease l on l.id = i.lease_id
       join applicant a on a.id = l.applicant_id
       join unit u on u.id = l.unit_id
       join property pr on pr.id = u.property_id
      where i.status in ('issued', 'part_paid')
        and i.due_on < ${sqlToday}
        and (${sqlToday} - i.due_on) % 7 = 3
        -- A tenant who sent a slip has done their part. Chasing them while the landlord has
        -- not looked at it yet reads as an accusation.
        and not exists (
          select 1 from payment_proof pp
           where pp.lease_id = i.lease_id and pp.status = 'pending'
             and (pp.invoice_id is null or pp.invoice_id = i.id))`,
  );
  for (const row of overdue) {
    if (Number(row.outstanding) <= 0) continue;
    const late = days(row.due_on, now);
    await notify({
      leaseId: row.lease_id,
      to: { sub: row.sub, email: row.email, phone: row.phone },
      kind: 'rent_overdue',
      dedupeKey: `rent_overdue:${row.invoice_id}:${today}`,
      data: {
        period: row.period, amount: zar(Number(row.outstanding)), dueOn: row.due_on,
        daysLate: String(late), reference: row.lease_ref, unit: row.unit,
      },
    });
    counts.overdueRent += 1;
  }

  /* Maintenance about to breach its target, and maintenance that already has. */
  const tickets = await query<{
    id: string; lease_id: string; title: string; severity: string; status: string;
    target_by: string; unit: string; landlord_sub: string; landlord_email: string; overdue: boolean;
  }>(
    `select t.id, t.lease_id, t.title, t.severity, t.status, t.target_by::text,
            pr.name || ' ' || u.code as unit,
            ll.cognito_sub as landlord_sub, ll.email as landlord_email,
            t.target_by < now() as overdue
       from ticket t
       join lease l on l.id = t.lease_id
       join unit u on u.id = l.unit_id
       join property pr on pr.id = u.property_id
       join landlord ll on ll.id = pr.landlord_id
      where t.status not in ('done', 'closed', 'cancelled')
        and t.target_by < now() + interval '6 hours'
        and ll.cognito_sub is not null`,
  );
  for (const row of tickets) {
    const hoursLeft = Math.max(
      0,
      Math.round((new Date(row.target_by).getTime() - now.getTime()) / 3600000),
    );
    await notify({
      leaseId: row.lease_id,
      to: { sub: row.landlord_sub, email: row.landlord_email },
      kind: row.overdue ? 'sla_breached' : 'sla_breach_soon',
      dedupeKey: `${row.overdue ? 'sla_breached' : 'sla_soon'}:${row.id}:${today}`,
      data: {
        title: row.title, unit: row.unit, status: row.status.replace(/_/g, ' '),
        targetBy: row.target_by.slice(0, 16).replace('T', ' '),
        severityLabel: row.severity.charAt(0).toUpperCase() + row.severity.slice(1),
        hoursLeft: String(hoursLeft),
      },
    });
    if (row.overdue) counts.slaBreached += 1;
    else counts.slaSoon += 1;
  }

  /* Inspections happening tomorrow, to both parties. */
  const inspections = await query<{
    id: string; lease_id: string; kind: string; scheduled_for: string; unit: string;
    tenant_sub: string; tenant_email: string; tenant_phone: string;
    landlord_sub: string; landlord_email: string;
  }>(
    `select i.id, i.lease_id, i.kind, i.scheduled_for::text,
            pr.name || ' ' || u.code as unit,
            a.cognito_sub as tenant_sub, a.email as tenant_email, a.phone as tenant_phone,
            ll.cognito_sub as landlord_sub, ll.email as landlord_email
       from inspection i
       join lease l on l.id = i.lease_id
       join applicant a on a.id = l.applicant_id
       join unit u on u.id = l.unit_id
       join property pr on pr.id = u.property_id
       join landlord ll on ll.id = pr.landlord_id
      where i.status = 'in_progress' and i.scheduled_for = ${sqlToday} + 1`,
  );
  for (const row of inspections) {
    const data = {
      unit: row.unit,
      date: row.scheduled_for,
      kindLabel: row.kind === 'incoming' ? 'Move-in' : 'Move-out',
    };
    await notify({
      leaseId: row.lease_id,
      to: { sub: row.tenant_sub, email: row.tenant_email, phone: row.tenant_phone },
      kind: 'inspection_tomorrow',
      dedupeKey: `inspection_tomorrow:${row.id}:tenant`,
      data,
    });
    if (row.landlord_sub) {
      await notify({
        leaseId: row.lease_id,
        to: { sub: row.landlord_sub, email: row.landlord_email },
        kind: 'inspection_tomorrow',
        dedupeKey: `inspection_tomorrow:${row.id}:landlord`,
        data,
      });
    }
    counts.inspections += 1;
  }

  /* A refund deadline is statutory, so the landlord gets told well before it lands. */
  const refunds = await query<{
    id: string; lease_id: string; refund_due_by: string; unit: string; tenant: string;
    landlord_sub: string; landlord_email: string; refund: string;
  }>(
    `select t.id, t.lease_id, t.refund_due_by::text,
            pr.name || ' ' || u.code as unit,
            a.first_name || ' ' || a.last_name as tenant,
            ll.cognito_sub as landlord_sub, ll.email as landlord_email,
            coalesce((select sum(d.amount_cents) from deposit_ledger d
                       where d.lease_id = t.lease_id and d.entry_type = 'refund'), 0)::text as refund
       from termination t
       join lease l on l.id = t.lease_id
       join applicant a on a.id = l.applicant_id
       join unit u on u.id = l.unit_id
       join property pr on pr.id = u.property_id
       join landlord ll on ll.id = pr.landlord_id
      where t.status = 'settled'
        and t.refund_due_by is not null
        and t.refund_due_by between ${sqlToday} and ${sqlToday} + 3
        and ll.cognito_sub is not null`,
  );
  for (const row of refunds) {
    if (Number(row.refund) <= 0) continue;
    await notify({
      leaseId: row.lease_id,
      to: { sub: row.landlord_sub, email: row.landlord_email },
      kind: 'refund_due_soon',
      dedupeKey: `refund_due:${row.id}:${today}`,
      data: {
        amount: zar(Number(row.refund)), tenant: row.tenant, unit: row.unit,
        dueBy: row.refund_due_by, daysLeft: String(days(today, new Date(row.refund_due_by))),
      },
    });
    counts.refunds += 1;
  }

  /* Leases running out, so a renewal or an exit inspection gets decided in time. */
  const ending = await query<{
    lease_id: string; end_date: string; unit: string;
    landlord_sub: string; landlord_email: string;
  }>(
    `select l.id as lease_id, l.end_date::text,
            pr.name || ' ' || u.code as unit,
            ll.cognito_sub as landlord_sub, ll.email as landlord_email
       from lease l
       join unit u on u.id = l.unit_id
       join property pr on pr.id = u.property_id
       join landlord ll on ll.id = pr.landlord_id
       left join termination t on t.lease_id = l.id and t.status <> 'withdrawn'
      where l.status = 'active' and t.id is null
        and l.end_date in (${sqlToday} + 60, ${sqlToday} + 30, ${sqlToday} + 7)
        and ll.cognito_sub is not null`,
  );
  for (const row of ending) {
    await notify({
      leaseId: row.lease_id,
      to: { sub: row.landlord_sub, email: row.landlord_email },
      kind: 'lease_ending_soon',
      dedupeKey: `lease_ending:${row.lease_id}:${row.end_date}:${days(today, new Date(row.end_date))}`,
      data: {
        unit: row.unit, endDate: row.end_date,
        daysLeft: String(days(today, new Date(row.end_date))),
      },
    });
    counts.leaseEnding += 1;
  }

  /* Renewal offers that have gone quiet, then the ones that ran out. */
  const openOffers = await query<{
    id: string; lease_id: string; respond_by: string; new_rent_cents: string; unit: string;
    sub: string | null; email: string; phone: string;
  }>(
    `select r.id, r.lease_id, r.respond_by::text, r.new_rent_cents,
            pr.name || ' ' || u.code as unit,
            a.cognito_sub as sub, a.email, a.phone
       from renewal r
       join lease l on l.id = r.lease_id
       join applicant a on a.id = l.applicant_id
       join unit u on u.id = l.unit_id
       join property pr on pr.id = u.property_id
      where r.status = 'offered' and r.respond_by between ${sqlToday} and ${sqlToday} + 3`,
  );
  for (const offer of openOffers) {
    if (!offer.sub) continue;
    await notify({
      leaseId: offer.lease_id,
      to: { sub: offer.sub, email: offer.email, phone: offer.phone },
      kind: 'renewal_expiring',
      dedupeKey: `renewal_expiring:${offer.id}:${today}`,
      data: {
        unit: offer.unit,
        newRent: zar(Number(offer.new_rent_cents)),
        respondBy: offer.respond_by,
        daysLeft: String(days(today, new Date(offer.respond_by))),
      },
    });
    counts.renewalsExpiring += 1;
  }

  // An offer nobody answered stops being an offer. Leaving it open would block the next one.
  const lapsed = await query<{ id: string }>(
    `update renewal set status = 'lapsed'
      where status = 'offered' and respond_by < ${sqlToday} returning id`,
  );
  counts.renewalsLapsed = lapsed.length;

  log.info('Notification sweep complete.', { ...counts });
  return counts;
};
