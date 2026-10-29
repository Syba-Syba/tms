import { formatZar } from '@hlonie/toolbox/utils';
/**
 * How the app writes dates and statuses for people. The API speaks ISO dates and database
 * statuses; nobody in Johannesburg reads "2026-10-07" or "part_paid" as words.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** "2026-10-07" or a timestamp → "7 Oct 2026". Read as a calendar date, never shifted by time zone. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[1]}`;
}

/** "2026-10" or "2026-10-01" → "October 2026". */
export function formatMonth(value: string | null | undefined): string {
  if (!value) return '';
  const match = /^(\d{4})-(\d{2})/.exec(value);
  return match ? `${LONG_MONTHS[Number(match[2]) - 1]} ${match[1]}` : value;
}

/** Whole days from today to a date: negative when it has passed. */
export function daysUntil(value: string): number {
  const today = new Date();
  const start = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const [y, m, d] = value.slice(0, 10).split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(y, m - 1, d) - start) / 86_400_000);
}

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

const STATUS: Record<string, { label: string; tone: Tone }> = {
  // Invoices
  issued: { label: 'Unpaid', tone: 'warning' },
  part_paid: { label: 'Part paid', tone: 'warning' },
  paid: { label: 'Paid', tone: 'success' },
  void: { label: 'Cancelled', tone: 'neutral' },
  // Leases
  draft: { label: 'Draft', tone: 'neutral' },
  out_for_signature: { label: 'Awaiting signatures', tone: 'info' },
  active: { label: 'Active', tone: 'success' },
  terminated: { label: 'Ended', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  // Units
  occupied: { label: 'Occupied', tone: 'success' },
  vacant: { label: 'Vacant', tone: 'neutral' },
  held: { label: 'Held for applicant', tone: 'info' },
  // Applications
  submitted: { label: 'Waiting', tone: 'info' },
  screening: { label: 'Screening', tone: 'info' },
  approved: { label: 'Approved', tone: 'success' },
  declined: { label: 'Declined', tone: 'neutral' },
  withdrawn: { label: 'Withdrawn', tone: 'neutral' },
  // Tickets
  open: { label: 'Open', tone: 'warning' },
  assigned: { label: 'Assigned', tone: 'info' },
  quote_pending: { label: 'Quote to approve', tone: 'warning' },
  quote_approved: { label: 'Quote approved', tone: 'info' },
  in_progress: { label: 'In progress', tone: 'info' },
  done: { label: 'Done', tone: 'success' },
  closed: { label: 'Closed', tone: 'neutral' },
  // Inspections
  awaiting_signatures: { label: 'Awaiting signatures', tone: 'info' },
  completed: { label: 'Signed', tone: 'success' },
  missed: { label: 'Missed', tone: 'danger' },
};

/** A database status → a label and badge tone. Unknown ones are tidied rather than shown raw. */
export function status(value: string): { label: string; tone: Tone } {
  const known = STATUS[value];
  if (known) return known;
  const words = value.replace(/_/g, ' ');
  return { label: words.charAt(0).toUpperCase() + words.slice(1), tone: 'neutral' };
}

/** A timestamp → "7 Oct 2026, 14:30" in the viewer's own time, which for this app is SAST. */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '';
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  return `${at.getDate()} ${MONTHS[at.getMonth()]} ${at.getFullYear()}, ${time}`;
}

export const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** A headline figure: whole rands drop the ",00", anything with cents keeps it exact. */
export const headlineZar = (cents: number) => formatZar(cents / 100, cents % 100 !== 0);
