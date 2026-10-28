import { query } from './db';
import { daysBetween, letterAllowed, reminderDue, LETTER_FROM_DAY, REMINDERS, type Step } from '../domain/arrears';
import { addDaysIso } from '../domain/dates';

type Run = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

export interface Owing {
  leaseId: string;
  oldestDueOn: string;
  outstandingCents: number;
  slipPending: boolean;
}

/**
 * Leases with rent past its due date and unpaid, as of `today` (SAST). Only invoices already
 * due count: next month's invoice, issued on the 25th, is not arrears.
 */
export async function owingLeases(today: string, leaseId?: string): Promise<Owing[]> {
  const rows = await query<{ lease_id: string; oldest_due_on: string; outstanding: string; slip_pending: boolean }>(
    `with open_due as (
       select i.lease_id, i.due_on,
              i.total_cents - coalesce((select sum(p.amount_cents) from payment p where p.invoice_id = i.id), 0) as owed
         from invoice i
         join lease l on l.id = i.lease_id
        where i.status in ('issued', 'part_paid') and i.due_on < $1::date
          and l.status in ('active', 'terminated')
          and ($2::uuid is null or i.lease_id = $2)
     )
     select lease_id, min(due_on)::text as oldest_due_on, sum(owed)::text as outstanding,
            exists (select 1 from payment_proof pp where pp.lease_id = open_due.lease_id and pp.status = 'pending')
              as slip_pending
       from open_due
      where owed > 0
      group by lease_id`,
    [today, leaseId ?? null],
  );
  return rows.map((row) => ({
    leaseId: row.lease_id,
    oldestDueOn: row.oldest_due_on,
    outstandingCents: Number(row.outstanding),
    slipPending: row.slip_pending,
  }));
}

export interface CaseRow {
  id: string;
  lease_id: string;
  opened_on: string;
  closed_on: string | null;
  paused_until: string | null;
  pause_reason: string | null;
}

export interface StepRow {
  step: Step;
  taken_on: string;
  days_late: number;
  outstanding_cents: string;
  remedy_by: string | null;
  document_s3_key: string | null;
}

/** The open case on a lease, opening one if it owes and has none. */
export async function ensureCase(run: Run, leaseId: string, today: string): Promise<CaseRow> {
  await run(
    `insert into arrears_case (lease_id, opened_on) values ($1, $2)
     on conflict (lease_id) where closed_on is null do nothing`,
    [leaseId, today],
  );
  const [row] = await run<CaseRow>(
    `select id, lease_id, opened_on::text, closed_on::text, paused_until::text, pause_reason
       from arrears_case where lease_id = $1 and closed_on is null`,
    [leaseId],
  );
  return row!;
}

export const stepsOf = (caseId: string) =>
  query<StepRow>(
    `select step, taken_on::text, days_late, outstanding_cents, remedy_by::text, document_s3_key
       from arrears_step where case_id = $1 order by taken_on, created_at`,
    [caseId],
  );

/** Everything the lease screen and the report say about a lease's arrears, as of today. */
export async function arrearsView(leaseId: string, today: string) {
  const [owing] = await owingLeases(today, leaseId);
  const cases = await query<CaseRow>(
    `select id, lease_id, opened_on::text, closed_on::text, paused_until::text, pause_reason
       from arrears_case where lease_id = $1 order by opened_on desc, created_at desc limit 4`,
    [leaseId],
  );
  const open = cases.find((row) => !row.closed_on) ?? null;
  const shape = async (row: CaseRow) => {
    const steps = await stepsOf(row.id);
    return {
      id: row.id,
      openedOn: row.opened_on,
      closedOn: row.closed_on,
      pausedUntil: row.paused_until && row.paused_until >= today ? row.paused_until : null,
      pauseReason: row.paused_until && row.paused_until >= today ? row.pause_reason : null,
      steps: steps.map((step) => ({
        step: step.step,
        takenOn: step.taken_on,
        daysLate: step.days_late,
        outstandingCents: Number(step.outstanding_cents),
        remedyBy: step.remedy_by,
        documentKey: step.document_s3_key,
      })),
    };
  };
  const current = open ? await shape(open) : null;
  let next: { step: Step; on: string } | null = null;
  let letter: { allowed: boolean; from: string } | null = null;
  if (owing) {
    const daysLate = daysBetween(owing.oldestDueOn, today);
    const taken = new Set<Step>(current?.steps.map((step) => step.step) ?? []);
    // The next automatic reminder: one due today that the job has not sent yet, or the next
    // rung up. Nothing while paused, and nothing once the letter has gone.
    const paused = Boolean(current?.pausedUntil);
    const dueNow = reminderDue(daysLate, taken);
    const later = REMINDERS.find((rung) => rung.day > daysLate && !taken.has(rung.step));
    if (!paused && !taken.has('letter_of_demand')) {
      if (dueNow) next = { step: dueNow, on: today };
      else if (later) next = { step: later.step, on: addDaysIso(owing.oldestDueOn, later.day) };
    }
    letter = {
      allowed: letterAllowed(daysLate, taken),
      from: addDaysIso(owing.oldestDueOn, LETTER_FROM_DAY),
    };
  }
  return {
    owing: owing
      ? {
          outstandingCents: owing.outstandingCents,
          oldestDueOn: owing.oldestDueOn,
          daysLate: daysBetween(owing.oldestDueOn, today),
          slipPending: owing.slipPending,
        }
      : null,
    case: current,
    next,
    letter,
    history: await Promise.all(cases.filter((row) => row.closed_on).map(shape)),
  };
}
