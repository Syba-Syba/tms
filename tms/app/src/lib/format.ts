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

/**
 * A Postgres text timestamp ("2026-10-07 22:33:06.087+00", what `at::text` sends) → ISO 8601
 * ("2026-10-07T22:33:06.087+00:00"). Chrome reads the Postgres form, Safari returns Invalid
 * Date for it, so every iPhone showed the raw string. ISO input passes through unchanged.
 */
export function toIsoInstant(value: string): string {
  return value
    .trim()
    .replace(/^(\d{4}-\d{2}-\d{2}) (?=\d)/, '$1T')
    .replace(/([+-]\d{2})$/, '$1:00')
    .replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
}

const parseInstant = (value: string): Date | null => {
  const at = new Date(toIsoInstant(value));
  return Number.isNaN(at.getTime()) ? null : at;
};

const SAST_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Johannesburg',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const sastParts = (at: Date) => {
  const parts = SAST_PARTS.formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { day: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}` };
};

/**
 * A moment in time (an *At or created_at from the API, in UTC) → "7 Oct 2026", on the
 * Johannesburg calendar. formatDate would show the UTC day, a day early before 02:00 SAST.
 * Plain YYYY-MM-DD dates (due dates, paid-on dates) still go through formatDate. A value that
 * will not parse falls back to the date as written.
 */
export function formatInstant(value: string | null | undefined): string {
  if (!value) return '';
  const at = parseInstant(value);
  if (!at) return formatDate(value);
  return formatDate(sastParts(at).day);
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

/** A timestamp → "7 Oct 2026, 14:30" on the Johannesburg clock, whatever the device's zone. */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '';
  const at = parseInstant(value);
  if (!at) return formatDate(value);
  const { day, time } = sastParts(at);
  return `${formatDate(day)}, ${time}`;
}

export const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** A headline figure: whole rands drop the ",00", anything with cents keeps it exact. */
export const headlineZar = (cents: number) => formatZar(cents / 100, cents % 100 !== 0);
