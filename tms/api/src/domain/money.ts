/** Rent escalates on each lease anniversary, compounding. The figure for any period is derived,
    never stored, so a corrected escalation percentage fixes history in one place. */
export function rentForPeriod(
  baseRentCents: number,
  escalationPct: number,
  leaseStart: Date,
  periodStart: Date,
): number {
  // Date-only values are parsed as UTC midnight, so read them back in UTC. Local getters
  // would shift the year for anyone running the job west of Greenwich.
  let years = periodStart.getUTCFullYear() - leaseStart.getUTCFullYear();
  const anniversary = new Date(leaseStart);
  anniversary.setUTCFullYear(leaseStart.getUTCFullYear() + years);
  if (periodStart < anniversary) years -= 1;
  const completed = Math.max(0, years);
  return Math.round(baseRentCents * (1 + escalationPct / 100) ** completed);
}

export type AgeBucket = 'current' | 'd30' | 'd60' | 'd90' | 'd90plus';

export function ageBucket(dueOn: Date, today: Date): AgeBucket {
  const days = Math.floor((today.getTime() - dueOn.getTime()) / 86400000);
  if (days <= 0) return 'current';
  if (days <= 30) return 'd30';
  if (days <= 60) return 'd60';
  if (days <= 90) return 'd90';
  return 'd90plus';
}

/** RHA: the deposit earns interest for the tenant, at no less than a savings rate. The rate is
    configuration, posted monthly as simple interest on the running balance. */
export const monthlyInterestCents = (balanceCents: number, annualPct: number) =>
  balanceCents <= 0 || annualPct <= 0 ? 0 : Math.round((balanceCents * annualPct) / 100 / 12);

export const zar = (cents: number) =>
  `R ${(cents / 100).toLocaleString('en-ZA', { minimumFractionDigits: 2 })}`;
