import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { Button, Card, CardBody, EmptyState, PageHeader, SegmentedControl, Spinner } from '@hlonie/toolbox/ui';
import { api } from '../api/client';
import { QueryError } from '../components/query-state';
import { describeAction } from '../lib/activity';
import { PAGE } from '../lib/layout';

interface Entry {
  id: number;
  at: string;
  action: string;
  entity: string;
  entityId: string | null;
  leaseId: string | null;
  actor: { role: string | null; name: string };
}

const FILTERS = [
  { label: 'Everything', value: 'all' },
  { label: 'Leases', value: 'lease' },
  { label: 'Sign-ins', value: 'credential' },
] as const;

const when = (at: string) =>
  new Date(at).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'medium', timeStyle: 'short' });

/** The audit log, read back: who did what, and when, on your properties and your account. */
export function Activity() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['value']>('all');
  const { data, isLoading, isError, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: ['audit', filter],
      initialPageParam: null as number | null,
      queryFn: ({ pageParam }) =>
        api.get<{ items: Entry[]; nextBefore: number | null }>('/audit', {
          query: {
            ...(filter === 'all' ? {} : { entity: filter }),
            ...(pageParam ? { before: String(pageParam) } : {}),
          },
        }),
      getNextPageParam: (last) => last.nextBefore,
    });

  const items = data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <main className={PAGE.reading}>
      <PageHeader
        title="Activity"
        description="Every change on your properties, every document opened, and every sign-in to your account."
      />

      <div className="mb-4 max-w-sm">
        <SegmentedControl value={filter} onChange={setFilter} options={[...FILTERS]} />
      </div>

      {isLoading ? <Spinner /> : null}
      {isError ? <QueryError error={error} onRetry={refetch} what="The activity log" /> : null}
      {!isLoading && !isError && items.length === 0 ? (
        <EmptyState title="Nothing yet" description="Changes appear here as they happen." />
      ) : null}

      <Card>
        <ul className="divide-y divide-line-soft">
          {items.map((entry) => (
            <li key={entry.id}>
              <CardBody className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3">
                <div>
                  <p className="text-body font-semibold text-ink">{describeAction(entry.action)}</p>
                  <p className="text-xs text-ink-muted">
                    {entry.actor.name}
                    {entry.leaseId ? (
                      <>
                        {' · '}
                        <button
                          type="button"
                          className="font-bold text-brand-500"
                          onClick={() => navigate(`/leases/${entry.leaseId}`)}
                        >
                          Open the lease
                        </button>
                      </>
                    ) : null}
                  </p>
                </div>
                <time className="text-xs text-ink-muted" dateTime={entry.at}>
                  {when(entry.at)}
                </time>
              </CardBody>
            </li>
          ))}
        </ul>
      </Card>

      {hasNextPage ? (
        <div className="mt-4">
          <Button block variant="outline" loading={isFetchingNextPage} onClick={() => fetchNextPage()}>
            Show older
          </Button>
        </div>
      ) : null}
    </main>
  );
}
