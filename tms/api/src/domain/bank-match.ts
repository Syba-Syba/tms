/**
 * Suggests which lease a bank credit belongs to. It only suggests: the landlord confirms every
 * line, because recording someone else's rent against a tenant is worse than recording nothing.
 *
 *   high    The lease reference is in the description and the amount fits what is owed, or
 *           matches a slip the tenant already sent.
 *   medium  The reference is there but the amount does not fit, or the tenant's surname is
 *           there and the amount is exactly what they owe or what their slip says.
 *   low     No reference and no name, but exactly one lease owes exactly this amount.
 */

export type Confidence = 'high' | 'medium' | 'low';

export interface LeaseCandidate {
  leaseId: string;
  refNo: number;
  tenantSurname: string;
  owedCents: number;
  pendingProofCents: number[];
}

export interface Suggestion {
  leaseId: string;
  confidence: Confidence;
  reason: string;
}

/** "LSE-00101", "lse 101", "LSE00101", "rent LSE-101 May". */
export function referencedRefNos(description: string): number[] {
  const found = new Set<number>();
  for (const match of description.matchAll(/(?<![A-Z])LSE[\s\-_:#]*0*(\d{1,7})(?!\d)/gi)) found.add(Number(match[1]));
  return [...found];
}

const words = (text: string) => new Set(text.toUpperCase().split(/[^A-Z]+/).filter((word) => word.length >= 3));

export function suggestLease(
  line: { amountCents: number; description: string },
  leases: LeaseCandidate[],
): Suggestion | null {
  const byRef = new Map(leases.map((lease) => [lease.refNo, lease]));
  const referenced = referencedRefNos(line.description)
    .map((refNo) => byRef.get(refNo))
    .filter((lease): lease is LeaseCandidate => Boolean(lease));

  if (referenced.length === 1) {
    const lease = referenced[0]!;
    if (lease.pendingProofCents.includes(line.amountCents)) {
      return { leaseId: lease.leaseId, confidence: 'high', reason: 'Reference matches, and so does the tenant\'s slip.' };
    }
    if (line.amountCents <= lease.owedCents) {
      return { leaseId: lease.leaseId, confidence: 'high', reason: 'Reference matches.' };
    }
    return {
      leaseId: lease.leaseId,
      confidence: 'medium',
      reason: lease.owedCents === 0
        ? 'Reference matches, but nothing is owed on this lease yet.'
        : 'Reference matches, but it is more than the lease owes.',
    };
  }
  // Two references in one line is someone paying for two units, and that needs a person.
  if (referenced.length > 1) return null;

  const inDescription = words(line.description);
  const named = leases.filter(
    (lease) =>
      lease.tenantSurname.length >= 3 &&
      inDescription.has(lease.tenantSurname.toUpperCase()) &&
      (lease.owedCents === line.amountCents || lease.pendingProofCents.includes(line.amountCents)),
  );
  if (named.length === 1) {
    return { leaseId: named[0]!.leaseId, confidence: 'medium', reason: 'Surname and amount match, but there is no reference.' };
  }

  const exact = leases.filter(
    (lease) => lease.owedCents === line.amountCents || lease.pendingProofCents.includes(line.amountCents),
  );
  if (exact.length === 1) {
    return { leaseId: exact[0]!.leaseId, confidence: 'low', reason: 'Only the amount matches. Check before confirming.' };
  }
  return null;
}
