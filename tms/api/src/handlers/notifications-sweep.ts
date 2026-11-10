import { query } from '../lib/db';
import { notify } from '../lib/notify';
import { zar } from '../domain/money';
import { jobLogger } from '../lib/logger';
import { addDaysIso, dateFromIso, isoDate, sastToday } from '../domain/dates';
import { sastDateTime } from '../domain/notification';
import {
  addBusinessDays,
  businessDaysBetween,
  outgoingCountsSql,
  outgoingInWindowSql,
  refundDueBy,
  type RefundRule,
} from '../domain/termination';

const log = jobLogger('notifications-sweep');

const days = (from: string, to: Date) =>
  Math.floor((to.getTime() - new Date(from).getTime()) / 86400000);

/**
 * Lease-ending reminders. CPA s14(2)(c) has the landlord tell the tenant 40 to 80 business days
 * before a fixed term expires; told later, the lease runs on month to month. The old 60 and 30
 * calendar day reminders were both inside the 40 business day minimum, too late to act on. The
 * first now comes when the window opens, at 80 business days, the second at 45, still before
 * the minimum, and the last a week out for the exit inspection. Each is sent once, on the first
 * sweep inside it; the key names the threshold.
 */
export const LEASE_ENDING_FIRST_BUSINESS_DAYS = 80;
export const LEASE_ENDING_SECOND_BUSINESS_DAYS = 45;
export const LEASE_ENDING_LAST_CALENDAR_DAYS = 7;

/** The nearest reminder reached for a lease ending on `endDate`, or null when none is due yet. */
export function leaseEndingThreshold(today: string, endDate: string): '80bd' | '45bd' | '7d' | null {
  const from = dateFromIso(today);
  const end = dateFromIso(endDate);
  if (end < from) return null;
  if (days(today, end) <= LEASE_ENDING_LAST_CALENDAR_DAYS) return '7d';
  const businessDays = businessDaysBetween(from, end);
  if (businessDays <= LEASE_ENDING_SECOND_BUSINESS_DAYS) return '45bd';
  if (businessDays <= LEASE_ENDING_FIRST_BUSINESS_DAYS) return '80bd';
  return null;
}

/**
 * Runs `send` for each row on its own. One bad row (a tenant with no address, a template field
 * missing) used to throw out of the whole sweep, and every step after it stopped running every
 * morning until someone noticed. Failures are logged and counted; the caller reports them.
 */
async function eachRow<T>(step: string, rows: T[], failures: string[], send: (row: T) => Promise<void>) {
  for (const row of rows) {
    try {
      await send(row);
    } catch (error) {
      failures.push(step);
      log.error('Notification sweep row failed.', { step, error });
    }
  }
}

/** Runs one step of the sweep, so a failing query is logged and the next step still runs. */
async function runStep(step: string, failures: string[], body: () => Promise<void>) {
  try {
    await body();
  } catch (error) {
    failures.push(step);
    log.error('Notification sweep step failed.', { step, error });
  }
}

/**
 * Maintenance about to breach its target, and maintenance that already has. A 6 hour warning
 * only works if something looks often, so this runs with every dispatch (every few minutes) as
 * well as in the morning sweep. The warning is keyed on the deadline, so it goes once however
 * often this runs; the breach notice is keyed on the day, so it repeats daily until handled.
 */
export async function slaSweep(now: Date = new Date()) {
  const today = sastToday(now);
  const failures: string[] = [];
  const counts = { slaSoon: 0, slaBreached: 0 };
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
  await eachRow('sla', tickets, failures, async (row) => {
    const hoursLeft = Math.max(
      0,
      Math.round((new Date(row.target_by).getTime() - now.getTime()) / 3600000),
    );
    await notify({
      leaseId: row.lease_id,
      to: { sub: row.landlord_sub, email: row.landlord_email },
      kind: row.overdue ? 'sla_breached' : 'sla_breach_soon',
      dedupeKey: row.overdue ? `sla_breached:${row.id}:${today}` : `sla_soon:${row.id}:${row.target_by}`,
      data: {
        title: row.title, unit: row.unit, status: row.status.replace(/_/g, ' '),
        targetBy: sastDateTime(row.target_by),
        severityLabel: row.severity.charAt(0).toUpperCase() + row.severity.slice(1),
        hoursLeft: String(hoursLeft),
      },
    });
    if (row.overdue) counts.slaBreached += 1;
    else counts.slaSoon += 1;
  });
  if (failures.length > 0) throw new Error(`Maintenance deadline warnings failed for ${failures.length} ticket(s).`);
  return counts;
}

/**
 * Runs every morning. Everything here is time-based rather than event-based, so nothing else
 * would ever raise it. Each notification carries a dedupe key, which is why running this twice
 * in a day is harmless. Each step runs on its own: a failure is logged, the rest still run, and
 * the sweep then fails as a whole so the scheduler retries it and raises an alert.
 */
export const handler = async () => {
  // The South African day, not UTC or the database's zone: between midnight and 02:00 SAST
  // those still say yesterday, and the reminders would go out a day late.
  const now = new Date();
  const today = sastToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`Bad date ${today}`);
  const sqlToday = `'${today}'::date`;
  const counts = { slaSoon: 0, slaBreached: 0, inspections: 0, refunds: 0,
                   unsettled: 0, awaitingNotices: 0, leaseEnding: 0, renewalsExpiring: 0, renewalsLapsed: 0 };
  const failures: string[] = [];

  // Unpaid rent is chased by the arrears run, which keeps the ladder on the lease.

  await runStep('sla', failures, async () => {
    Object.assign(counts, await slaSweep(now));
  });

  /* Inspections happening tomorrow, to both parties. Today's are included too, so a sweep
     that did not run yesterday still reminds them; the dedupe key keeps it to one reminder.
     A tenant imported without an account is addressed by their applicant row: recipient_sub
     cannot be null, and that one null failed the whole sweep every morning. */
  await runStep('inspections', failures, async () => {
    const inspections = await query<{
      id: string; lease_id: string; kind: string; scheduled_for: string; unit: string;
      tenant_sub: string; tenant_email: string; tenant_phone: string;
      landlord_sub: string; landlord_email: string;
    }>(
      `select i.id, i.lease_id, i.kind, i.scheduled_for::text,
              pr.name || ' ' || u.code as unit,
              coalesce(a.cognito_sub, 'applicant:' || a.id) as tenant_sub,
              a.email as tenant_email, a.phone as tenant_phone,
              ll.cognito_sub as landlord_sub, ll.email as landlord_email
         from inspection i
         join lease l on l.id = i.lease_id
         join applicant a on a.id = l.applicant_id
         join unit u on u.id = l.unit_id
         join property pr on pr.id = u.property_id
         join landlord ll on ll.id = pr.landlord_id
        where i.status = 'in_progress'
          and l.status in ('out_for_signature', 'scheduled', 'active')
          and i.scheduled_for between ${sqlToday} and ${sqlToday} + 1`,
    );
    await eachRow('inspections', inspections, failures, async (row) => {
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
    });
  });

  /* A refund deadline is statutory, so the landlord gets told well before it lands. */
  await runStep('refunds', failures, async () => {
    const refunds = await query<{
      id: string; lease_id: string; refund_due_by: string; unit: string; tenant: string;
      landlord_sub: string; landlord_email: string; refund: string;
    }>(
      `select t.id, t.lease_id, t.refund_due_by::text,
              pr.name || ' ' || u.code as unit,
              a.first_name || ' ' || a.last_name as tenant,
              ll.cognito_sub as landlord_sub, ll.email as landlord_email,
              -- The statement's refund, rent credit included. Settlements from before it was
              -- stored fall back to the deposit ledger's refund.
              coalesce(t.refund_cents, (select sum(d.amount_cents) from deposit_ledger d
                         where d.lease_id = t.lease_id and d.entry_type = 'refund'), 0)::text as refund
         from termination t
         join lease l on l.id = t.lease_id
         join applicant a on a.id = l.applicant_id
         join unit u on u.id = l.unit_id
         join property pr on pr.id = u.property_id
         join landlord ll on ll.id = pr.landlord_id
        where t.status = 'settled'
          and t.refund_due_by is not null
          -- Recorded as paid: nothing left to warn about.
          and t.refund_paid_on is null
          and t.refund_due_by between ${sqlToday} and ${sqlToday} + 3
          and ll.cognito_sub is not null`,
    );
    await eachRow('refunds', refunds, failures, async (row) => {
      if (Number(row.refund) <= 0) return;
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
    });
  });

  /* Deposits nobody has settled. The refund clock (RHA s5(3)) runs from the lease end whether
     or not the landlord settles, and the reminder above only fires once they have. The landlord
     is told when the lease has ended, three days before the provisional deadline, and once it
     has passed. The deadline is 7 days with a completed exit inspection and no deductions, 21
     with no exit inspection, and with deductions at the earliest 14 days from the lease end,
     since the unit cannot be restored before the tenant leaves. */
  await runStep('unsettled', failures, async () => {
    const open = await query<{
      id: string; lease_id: string; effective_on: string; unit: string; tenant: string;
      landlord_sub: string; landlord_email: string; inspected: boolean; deductions: boolean;
    }>(
      `select t.id, t.lease_id, t.effective_on::text,
              pr.name || ' ' || u.code as unit,
              a.first_name || ' ' || a.last_name as tenant,
              ll.cognito_sub as landlord_sub, ll.email as landlord_email,
              exists (select 1 from inspection i
                       where i.lease_id = t.lease_id and ${outgoingInWindowSql('i', 't')}
                         and ${outgoingCountsSql('i', sqlToday)}) as inspected,
              exists (select 1 from deposit_deduction d where d.termination_id = t.id) as deductions
         from termination t
         join lease l on l.id = t.lease_id
         join applicant a on a.id = l.applicant_id
         join unit u on u.id = l.unit_id
         join property pr on pr.id = u.property_id
         join landlord ll on ll.id = pr.landlord_id
        where t.status not in ('settled', 'withdrawn')
          and l.status = 'active'
          and t.effective_on <= ${sqlToday}
          -- Waiting on the tenant's confirmation it cannot be settled; nothing to remind of.
          and not (t.needs_tenant_confirmation and t.tenant_confirmed_at is null)
          and ll.cognito_sub is not null`,
    );
    await eachRow('unsettled', open, failures, async (row) => {
      const rule: RefundRule = !row.inspected ? 'no_inspection' : row.deductions ? 'with_deductions' : 'no_deductions';
      const deadline = isoDate(refundDueBy(rule, dateFromIso(row.effective_on)));
      const threshold = today > deadline ? 'overdue' : today >= addDaysIso(deadline, -3) ? 'due_soon' : 'ended';
      const deadlineLine =
        rule === 'with_deductions'
          ? `With deductions the refund is due 14 days after the unit is restored, so no later than ${deadline} if it was restored the day the lease ended.`
          : threshold === 'overdue'
            ? `The refund was due by ${deadline}.`
            : `The refund is due by ${deadline}.`;
      await notify({
        leaseId: row.lease_id,
        to: { sub: row.landlord_sub, email: row.landlord_email },
        kind: 'deposit_unsettled',
        dedupeKey: `deposit_unsettled:${row.id}:${row.effective_on}:${threshold}`,
        data: { unit: row.unit, tenant: row.tenant, effectiveOn: row.effective_on, deadlineLine },
      });
      counts.unsettled += 1;
    });
  });

  /* Notices the landlord recorded that the tenant has not confirmed. Such a notice is not in
     force: rent is billed and the deposit cannot be settled. The tenant was asked once, when it
     was recorded, and after that nobody heard of it again. Both are reminded 3 and 7 days after
     it was recorded and weekly from 14. Once its end date has passed the tenant can no longer
     confirm it, so only the landlord is told, at once and then on the same days. */
  await runStep('awaitingNotices', failures, async () => {
    const waiting = await query<{
      id: string; lease_id: string; effective_on: string; recorded_on: string; age: number; unit: string;
      tenant_sub: string | null; tenant_email: string; tenant_phone: string;
      landlord_sub: string | null; landlord_email: string;
    }>(
      `select t.id, t.lease_id, t.effective_on::text,
              (t.created_at at time zone 'Africa/Johannesburg')::date::text as recorded_on,
              (${sqlToday} - (t.created_at at time zone 'Africa/Johannesburg')::date)::int as age,
              pr.name || ' ' || u.code as unit,
              a.cognito_sub as tenant_sub, a.email as tenant_email, a.phone as tenant_phone,
              ll.cognito_sub as landlord_sub, ll.email as landlord_email
         from termination t
         join lease l on l.id = t.lease_id
         join applicant a on a.id = l.applicant_id
         join unit u on u.id = l.unit_id
         join property pr on pr.id = u.property_id
         join landlord ll on ll.id = pr.landlord_id
        where t.status not in ('settled', 'withdrawn')
          and l.status = 'active'
          and t.needs_tenant_confirmation and t.tenant_confirmed_at is null`,
    );
    await eachRow('awaitingNotices', waiting, failures, async (row) => {
      const past = today > row.effective_on;
      const step = row.age >= 14 ? `w${Math.floor(row.age / 7)}` : row.age >= 7 ? 'd7' : row.age >= 3 ? 'd3' : null;
      if (row.tenant_sub && !past && step) {
        await notify({
          leaseId: row.lease_id,
          to: { sub: row.tenant_sub, email: row.tenant_email, phone: row.tenant_phone },
          kind: 'notice_confirm_reminder',
          dedupeKey: `notice_awaiting:${row.id}:tenant:${step}`,
          data: { unit: row.unit, effectiveOn: row.effective_on },
        });
      }
      const data = {
        unit: row.unit, effectiveOn: row.effective_on, recordedOn: row.recorded_on,
        stateLine: past
          ? 'That date has passed, so the tenant can no longer confirm it in the app. The lease is still running: rent is billed and the deposit cannot be settled.'
          : 'Until they do the notice is not in force: rent is billed as usual and the deposit cannot be settled.',
        nextLine:
          'If you hold the tenant’s written notice, attach it to the notice in the app and confirm it yourself. ' +
          (past ? 'Otherwise withdraw it and record a fresh notice.' : 'Otherwise ask them to confirm it, or withdraw it.'),
      };
      if (row.landlord_sub && past) {
        await notify({
          leaseId: row.lease_id,
          to: { sub: row.landlord_sub, email: row.landlord_email },
          kind: 'notice_awaiting_tenant',
          dedupeKey: `notice_awaiting:${row.id}:landlord:past`,
          data,
        });
      }
      if (row.landlord_sub && step) {
        await notify({
          leaseId: row.lease_id,
          to: { sub: row.landlord_sub, email: row.landlord_email },
          kind: 'notice_awaiting_tenant',
          dedupeKey: `notice_awaiting:${row.id}:landlord:${step}`,
          data,
        });
      }
      counts.awaitingNotices += 1;
    });
  });

  /* Leases running out, so a renewal or notice is given inside the CPA window and the exit
     inspection gets booked. Each reminder covers a range rather than one exact day, so a sweep
     that missed its day still sends it the next morning; the key names the threshold, so it
     goes once. */
  await runStep('leaseEnding', failures, async () => {
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
          -- A renewal already accepted or signed: the tenant is staying, nothing to decide.
          and not exists (select 1 from lease n where n.previous_lease_id = l.id and n.status in ('scheduled', 'active'))
          and l.end_date between ${sqlToday} and $1::date
          and ll.cognito_sub is not null`,
      [isoDate(addBusinessDays(dateFromIso(today), LEASE_ENDING_FIRST_BUSINESS_DAYS))],
    );
    await eachRow('leaseEnding', ending, failures, async (row) => {
      const daysLeft = days(today, new Date(row.end_date));
      // The nearest threshold reached: 60 business days out is the 80 day reminder, 5 days out the 7.
      const threshold = leaseEndingThreshold(today, row.end_date);
      if (threshold === null) return;
      await notify({
        leaseId: row.lease_id,
        to: { sub: row.landlord_sub, email: row.landlord_email },
        kind: 'lease_ending_soon',
        dedupeKey: `lease_ending:${row.lease_id}:${row.end_date}:${threshold}`,
        data: { unit: row.unit, endDate: row.end_date, daysLeft: String(daysLeft) },
      });
      counts.leaseEnding += 1;
    });
  });

  /* Renewal offers that have gone quiet, then the ones that ran out. */
  await runStep('renewalsExpiring', failures, async () => {
    const openOffers = await query<{
      id: string; lease_id: string; respond_by: string; new_rent_cents: string; unit: string;
      sub: string | null; email: string; phone: string;
    }>(
      `select r.id, r.lease_id, r.respond_by::text, r.new_rent_cents,
              pr.name || ' ' || u.code as unit,
              coalesce(a.cognito_sub, 'applicant:' || a.id) as sub, a.email, a.phone
         from renewal r
         join lease l on l.id = r.lease_id
         join applicant a on a.id = l.applicant_id
         join unit u on u.id = l.unit_id
         join property pr on pr.id = u.property_id
        where r.status = 'offered' and r.respond_by between ${sqlToday} and ${sqlToday} + 3`,
    );
    await eachRow('renewalsExpiring', openOffers, failures, async (offer) => {
      if (!offer.sub) return;
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
    });
  });

  // An offer nobody answered stops being an offer. Leaving it open would block the next one.
  await runStep('renewalsLapsed', failures, async () => {
    const lapsed = await query<{ id: string }>(
      `update renewal set status = 'lapsed'
        where status = 'offered' and respond_by < ${sqlToday} returning id`,
    );
    counts.renewalsLapsed = lapsed.length;
  });

  if (failures.length > 0) {
    log.error('Notification sweep finished with failures.', { ...counts, failed: failures });
    throw new Error(`Notification sweep failed in: ${[...new Set(failures)].join(', ')}.`);
  }
  log.info('Notification sweep complete.', { ...counts });
  return counts;
};
