/** The lease a tenant is living under now. The list is newest first, so an accepted renewal
    that has not started yet would otherwise stand in for the current tenancy. With ended
    leases in the list, one is chosen only when nothing else is left: a settled tenancy's
    documents must stay reachable. */
export function currentLease<T extends { status: string }>(items: T[]): T | undefined {
  return (
    items.find((item) => item.status === 'active') ??
    items.find((item) => item.status !== 'terminated') ??
    items[0]
  );
}

/**
 * What the lease card on the documents screen says about the paperwork. It used to say
 * "Signed" whenever the PDF existed, which is from the moment it is generated, before anyone
 * has signed it.
 */
export function leaseDocumentBadge(lease: {
  hasDocument: boolean;
  status: string;
  source?: string;
  signatures?: { party: string }[];
}): { label: string; tone: 'success' | 'info' | 'neutral' } {
  const parties = new Set((lease.signatures ?? []).map((signature) => signature.party));
  if (parties.has('landlord') && parties.has('tenant')) return { label: 'Signed', tone: 'success' };
  // Imported tenancies were signed before Threshold; there is no document or signature here.
  if (lease.source === 'import') return { label: 'Signed on paper', tone: 'neutral' };
  if (lease.hasDocument && ['out_for_signature', 'draft', 'scheduled'].includes(lease.status)) {
    return { label: 'Awaiting signatures', tone: 'info' };
  }
  return { label: 'Not issued', tone: 'neutral' };
}
