/**
 * POPIA rules in one place. The notice itself lives in the app (src/screens/privacy.tsx); its
 * version lives here and in app/src/lib/privacy.ts, and a test keeps the two the same.
 */

/** Bump this whenever the notice's substance changes. Everyone is asked to accept it again. */
export const PRIVACY_VERSION = '2026-10-27';

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

/**
 * The date until which a person's records must be kept, or null when nothing holds them.
 * A lease that never took effect (draft or cancelled) holds nothing.
 */
export function retainedUntil(leases: LeaseForRetention[]): string | null {
  let latest: string | null = null;
  for (const lease of leases) {
    if (lease.status === 'draft' || lease.status === 'cancelled') continue;
    const ended = lease.terminationEffectiveOn && lease.terminationEffectiveOn < lease.endDate
      ? lease.terminationEffectiveOn
      : lease.endDate;
    const until = addYears(ended, LEASE_RETENTION_YEARS);
    if (!latest || until > latest) latest = until;
  }
  return latest;
}

/** Whether erasure can go ahead today, and if not, the plain reason a tenant is given. */
export function erasureBlock(leases: LeaseForRetention[], today: string): string | null {
  const until = retainedUntil(leases);
  if (!until || until <= today) return null;
  return (
    `Your lease records must be kept until ${until}: the law requires a landlord to keep rent, ` +
    'deposit and lease records for five years after a tenancy ends. They are used for nothing ' +
    'else, and you can ask again after that date.'
  );
}
