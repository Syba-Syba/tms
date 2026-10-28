import { addBusinessDays } from './termination';

/**
 * The arrears ladder. Each rung is taken once per case. The reminders are automatic; the letter
 * of demand is a legal step, so the system only says when it is ready and the landlord sends it.
 */
export type Reminder = 'reminder_1' | 'reminder_3' | 'reminder_7';
export type Step = Reminder | 'letter_of_demand';

export const REMINDERS: { step: Reminder; day: number }[] = [
  { step: 'reminder_1', day: 1 },
  { step: 'reminder_3', day: 3 },
  { step: 'reminder_7', day: 7 },
];

/** From this many days late the landlord may send the letter of demand. */
export const LETTER_FROM_DAY = 7;

/**
 * Business days the letter gives to pay. CPA s14(2)(b)(ii): before cancelling a fixed-term
 * lease for a material failure to comply, the landlord gives the tenant 20 business days'
 * written notice to rectify it.
 */
export const REMEDY_BUSINESS_DAYS = 20;

/** Longest a landlord can pause reminders in one go, so a pause is a decision, not a habit. */
export const MAX_PAUSE_DAYS = 60;

/**
 * The reminder to send today, if any. Only the highest rung due is sent: a job that was down
 * for a week sends the day-7 reminder once, not three messages in a row. A rung below one
 * already taken is never sent afterwards.
 */
export function reminderDue(daysLate: number, taken: ReadonlySet<Step>): Reminder | null {
  const due = REMINDERS.filter((rung) => daysLate >= rung.day);
  const highest = due[due.length - 1];
  if (!highest) return null;
  const takenHigher = REMINDERS.some((rung) => rung.day >= highest.day && taken.has(rung.step));
  if (takenHigher || taken.has('letter_of_demand')) return null;
  return highest.step;
}

export const letterAllowed = (daysLate: number, taken: ReadonlySet<Step>) =>
  daysLate >= LETTER_FROM_DAY && !taken.has('letter_of_demand');

/** The date by which the letter requires payment. Counting starts the day after it is sent. */
export const remedyBy = (sentOn: string) =>
  addBusinessDays(new Date(`${sentOn}T00:00:00Z`), REMEDY_BUSINESS_DAYS).toISOString().slice(0, 10);

export const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export const STEP_LABEL: Record<Step, string> = {
  reminder_1: 'First reminder',
  reminder_3: 'Second reminder',
  reminder_7: 'Final reminder',
  letter_of_demand: 'Letter of demand',
};
