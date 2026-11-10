import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { Avatar, Badge, Button, Card, EmptyState, PageHeader, SegmentedControl, Spinner } from '@hlonie/toolbox/ui';
import { api } from '../api/client';
import { QueryError } from '../components/query-state';
import { describeAction } from '../lib/activity';
import { formatDate, toIsoInstant } from '../lib/format';
import { localToday, addDays } from '../lib/dates';
import { PAGE } from '../lib/layout';
import { currentUser } from '../lib/session';

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

// The API sends Postgres's own timestamp text ('2026-10-07 22:33:06+00'), which Safari will not
// parse; every row read 'Invalid Date' on an iPhone.
export const activityTime = (at: string) =>
  new Date(toIsoInstant(at)).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'medium', timeStyle: 'short' });

const instant = (at: string) => new Date(toIsoInstant(at));
/** The Johannesburg calendar day of an entry, as YYYY-MM-DD, for grouping. */
const dayOf = (at: string) => {
  const date = instant(at);
  return Number.isNaN(date.getTime()) ? at.slice(0, 10) : date.toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
};
const clockOf = (at: string) => {
  const date = instant(at);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString('en-ZA', { timeZone: 'Africa/Johannesburg', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
};

type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info';
/** What kind of thing an entry is about, as a pill: the first word of the action says it. */
const KINDS: Record<string, { label: string; tone: Tone }> = {
  auth: { label: 'Sign-in', tone: 'neutral' },
  file: { label: 'Document', tone: 'info' },
  application: { label: 'Application', tone: 'info' },
  lease: { label: 'Lease', tone: 'brand' },
  renewal: { label: 'Lease', tone: 'brand' },
  termination: { label: 'Notice', tone: 'warning' },
  payment: { label: 'Payment', tone: 'success' },
  invoice: { label: 'Invoice', tone: 'success' },
  expense: { label: 'Expense', tone: 'neutral' },
  property: { label: 'Property', tone: 'neutral' },
  unit: { label: 'Property', tone: 'neutral' },
  inspection: { label: 'Inspection', tone: 'info' },
  ticket: { label: 'Repair', tone: 'warning' },
  landlord: { label: 'Account', tone: 'neutral' },
  billing: { label: 'Plan', tone: 'neutral' },
  privacy: { label: 'Privacy', tone: 'neutral' },
};
const kindOf = (action: string): { label: string; tone: Tone } => {
  if (action === 'auth.login_failed') return { label: 'Failed sign-in', tone: 'danger' };
  const head = action.split('.')[0] ?? '';
  const known = KINDS[head];
  if (known) return known;
  const words = head.replace(/_/g, ' ');
  return { label: words.charAt(0).toUpperCase() + words.slice(1), tone: 'neutral' };
};

const ROLES: Record<string, string> = { landlord: 'Landlord', tenant: 'Tenant', system: 'Threshold' };

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

  // Newest first from the server; a new heading starts each time the day changes.
  const days: { day: string; entries: Entry[] }[] = [];
  for (const entry of items) {
    const day = dayOf(entry.at);
    const last = days[days.length - 1];
    if (last && last.day === day) last.entries.push(entry);
    else days.push({ day, entries: [entry] });
  }
  const me = currentUser()?.name ?? 'You';
  const today = localToday();
  const heading = (day: string) => (day === today ? 'Today' : day === addDays(today, -1) ? 'Yesterday' : formatDate(day));

  return (
    <main className={PAGE.wide}>
      <PageHeader
        title="Activity"
        description="Every change on your properties, every document opened, and every sign-in to your account."
      />

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-5">
          <SegmentedControl value={filter} onChange={setFilter} options={[...FILTERS]} />

          {isLoading ? <Spinner /> : null}
          {isError ? <QueryError error={error} onRetry={refetch} what="The activity log" /> : null}
          {!isLoading && !isError && items.length === 0 ? (
            <EmptyState
              title="Nothing yet"
              description={
                filter === 'all'
                  ? 'Changes appear here as they happen: a payment recorded, a lease signed, a sign-in.'
                  : 'Nothing of this kind yet. Changes appear here as they happen.'
              }
              action={filter === 'all' ? undefined : <Button variant="outline" onClick={() => setFilter('all')}>Show everything</Button>}
            />
          ) : null}

          {days.map((group) => (
            <section key={group.day} aria-label={heading(group.day)}>
              <Card>
                <div className="flex items-baseline justify-between gap-3 px-5 py-3.5">
                  <h2 className="text-lead font-bold text-ink">{heading(group.day)}</h2>
                  <p className="text-meta text-ink-muted">
                    {group.entries.length === 1 ? '1 entry' : `${group.entries.length} entries`}
                  </p>
                </div>
                <ul className="divide-y divide-line-soft border-t border-line-soft">
                  {group.entries.map((entry) => {
                    const kind = kindOf(entry.action);
                    // The server names the reader's own entries 'You'.
                    const self = entry.actor.name === 'You';
                    const role = entry.actor.role ? ROLES[entry.actor.role] ?? entry.actor.role : null;
                    return (
                      <li key={entry.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3.5">
                        <Avatar name={self ? me : entry.actor.name} />
                        <div className="min-w-0 flex-1 basis-40">
                          <p className="text-body text-ink">
                            <span className="font-semibold">{describeAction(entry.action)}</span>{' '}
                            <span className="text-ink-muted">by {self ? 'you' : entry.actor.name}</span>
                          </p>
                          <p className="mt-1 flex flex-wrap items-center gap-2 text-meta text-ink-muted">
                            <Badge tone={kind.tone}>{kind.label}</Badge>
                            {role ? <span>{role}</span> : null}
                          </p>
                        </div>
                        {entry.leaseId ? (
                          <Button size="sm" variant="outline" onClick={() => navigate(`/leases/${entry.leaseId}`)}>
                            Open the lease
                          </Button>
                        ) : null}
                        <time className="w-14 shrink-0 text-right text-meta text-ink-muted" dateTime={entry.at} title={activityTime(entry.at)}>
                          {clockOf(entry.at)}
                        </time>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            </section>
          ))}

          {hasNextPage ? (
            <Button block variant="outline" loading={isFetchingNextPage} onClick={() => fetchNextPage()}>
              Show older
            </Button>
          ) : null}
        </div>

        <aside className="space-y-5">
          <Card>
            <div className="space-y-2 px-5 py-4">
              <h2 className="text-lead font-bold text-ink">What is recorded</h2>
              <ul className="list-disc space-y-1.5 pl-5 text-meta text-ink-muted">
                <li>Every change to a lease, payment, deposit, inspection or repair, with who made it.</li>
                <li>Every time a document is opened.</li>
                <li>Every sign-in, and every failed attempt.</li>
              </ul>
            </div>
          </Card>
          <div className="rounded-md border border-[color-mix(in_srgb,var(--tb-info)_25%,transparent)] bg-tint-info px-5 py-4">
            <h2 className="text-body font-bold text-ink">A record you can point to</h2>
            <p className="mt-1 text-meta text-ink">
              Entries are written by Threshold as things happen, not typed in by anyone, so the list shows who did
              what if a tenant or the Tribunal asks.
            </p>
          </div>
        </aside>
      </div>
    </main>
  );
}
