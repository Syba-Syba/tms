/**
 * POPIA rules in one place. The notice itself lives in the app (src/screens/privacy.tsx); its
 * version lives here and in app/src/lib/privacy.ts, and a test keeps the two the same.
 */

/** Bump this whenever the notice's substance changes. Everyone is asked to accept it again. */
export const PRIVACY_VERSION = '2026-10-28';

/**
 * How long a tenancy's records are kept after it ends. The Tax Administration Act has the
 * landlord keep records behind a tax return for five years, and rent, deposits and the lease
 * are exactly those records. A deposit dispute at the Rental Housing Tribunal also needs them.
 */
export const LEASE_RETENTION_YEARS = 5;

/** Paperwork of applicants who never became tenants. Long enough for a complaint about the decision. */
export const DECLINED_RETENTION_MONTHS = 12;

export interface LeaseForRetention {
  status: string;
  endDate: string;
  terminationEffectiveOn: string | null;
}

const addYears = (iso: string, years: number) => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y + years, m - 1, d));
  return date.toISOString().slice(0, 10);
};

/** Lease states in which the tenancy is still running, whatever the end date says. */
const LIVE = new Set(['active', 'scheduled', 'out_for_signature']);

/** Stands for "while the tenancy runs, and five years after": no date erasure could pass. */
export const STILL_RUNNING = '9999-12-31';

/**
 * The date until which a person's records must be kept, or null when nothing holds them.
 * A lease that never took effect (draft or cancelled) holds nothing. A live lease holds them
 * without end: a tenant holding over past the end date (month to month) is still a tenant.
 * A terminated lease counts from when the termination took effect, which is when the tenancy
 * really ended: earlier than the end date for an early exit, later for a holdover.
 */
export function retainedUntil(leases: LeaseForRetention[]): string | null {
  let latest: string | null = null;
  for (const lease of leases) {
    if (lease.status === 'draft' || lease.status === 'cancelled') continue;
    if (LIVE.has(lease.status)) return STILL_RUNNING;
    const ended = lease.terminationEffectiveOn ?? lease.endDate;
    const until = addYears(ended, LEASE_RETENTION_YEARS);
    if (!latest || until > latest) latest = until;
  }
  return latest;
}

/** Whether erasure can go ahead today, and if not, the plain reason a tenant is given. */
export function erasureBlock(leases: LeaseForRetention[], today: string): string | null {
  const until = retainedUntil(leases);
  if (!until || until <= today) return null;
  if (until === STILL_RUNNING) {
    return (
      'Your tenancy is still running, and your lease records must be kept until it ends and for ' +
      'five years after: the law requires a landlord to keep rent, deposit and lease records for ' +
      'five years after a tenancy ends.'
    );
  }
  return (
    `Your lease records must be kept until ${until}: the law requires a landlord to keep rent, ` +
    'deposit and lease records for five years after a tenancy ends. They are used for nothing ' +
    'else, and you can ask again after that date.'
  );
}
