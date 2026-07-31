import { QueryClient } from '@tanstack/react-query';
import { HttpError } from './http';

/** Shared defaults so every app fails and refetches the same way. */
export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          if (error instanceof HttpError && error.status < 500) return false;
          return failureCount < 2;
        },
      },
      mutations: { retry: 0 },
    },
  });
}

export const queryKeys = {
  list: (resource: string, params?: Record<string, unknown>) =>
    params ? ([resource, 'list', params] as const) : ([resource, 'list'] as const),
  detail: (resource: string, id: string | number) => [resource, 'detail', id] as const,
};
