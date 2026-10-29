import type { QueryClient } from '@tanstack/react-query';

/**
 * Every cached view a payment, an accepted slip or a matched bank line can change. These are
 * the query keys the screens actually use (grep `queryKey:`); invalidating a key nobody reads
 * (['reports'] used to be invalidated here) leaves the real one stale until a reload.
 * Prefix matching covers every variant, e.g. ['report-income', from, to] or ['lease', id].
 * Statement lines and invoices live inside ['lease', id] and ['statement', id].
 */
export const MONEY_QUERY_KEYS = [
  ['lease'],
  ['leases'],
  ['arrears'],
  ['statement'],
  ['report-arrears'],
  ['report-income'],
] as const;

export function invalidateMoneyCaches(queryClient: QueryClient): Promise<void> {
  return Promise.all(
    MONEY_QUERY_KEYS.map((queryKey) => queryClient.invalidateQueries({ queryKey: [...queryKey] })),
  ).then(() => undefined);
}
