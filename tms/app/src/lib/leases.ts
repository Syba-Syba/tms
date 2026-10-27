/** The lease a tenant is living under now. The list is newest first, so an accepted renewal
    that has not started yet would otherwise stand in for the current tenancy. */
export function currentLease<T extends { status: string }>(items: T[]): T | undefined {
  return items.find((item) => item.status === 'active') ?? items[0];
}
