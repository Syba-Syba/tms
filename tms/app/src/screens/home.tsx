import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { Badge, Card, CardBody, EmptyState, Input, PageHeader } from '@hlonie/toolbox/ui';
import { formatZar } from '@hlonie/toolbox/utils';
import { api } from '../api/client';
import { ChevronRightIcon } from '@hlonie/toolbox/icons';
import { daysUntil, formatDate, headlineZar, status } from '../lib/format';
import { QueryState } from '../components/query-state';
import { SetupChecklist } from '../components/setup-checklist';
import { isLandlord } from '../lib/session';
import { TenantHome } from './tenant-home';
import { PAGE } from '../lib/layout';
import { Money } from '../components/money';
import { CollectionsChart, type MonthTotal } from '../components/collections-chart';

interface LeaseRow {
  id: string;
  ref: string;
  status: string;
  unit: string;
  tenant: string;
  startDate: string;
  endDate: string;
  monthlyRentCents: number;
  depositBalanceCents: number;
  outstandingCents: number;
  openTickets: number;
  terminationEffectiveOn: string | null;
  renewalOffered: boolean;
}

interface Task {
  key: string;
  to: string;
  title: string;
  detail: string;
  tone: 'danger' | 'warning' | 'info';
}

const zar = (cents: number) => formatZar(cents / 100);

const STAGE: Record<string, string> = {
  reminder_1: 'first reminder sent',
  reminder_3: 'second reminder sent',
  reminder_7: 'final reminder sent',
  letter_of_demand: 'letter of demand sent',
};
const today = () => new Date().toISOString().slice(0, 10);

export function Home() {
  // A tenant has one home, not a portfolio, so they get a different screen entirely.
  if (!isLandlord()) return <TenantHome />;
  return <LandlordHome />;
}

/**
 * What a landlord needs in the first ten seconds: how the month is going, what needs them,
 * and every lease at a glance. Each panel loads on its own, so a slow one never blanks the page.
 */
function LandlordHome() {
  const monthStart = `${today().slice(0, 7)}-01`;
  const leases = useQuery({
    queryKey: ['leases'],
    queryFn: () => api.get<{ items: LeaseRow[] }>('/leases'),
  });
  // Six months, for the trend; this month's figures are the last of them.
  const sixMonthsAgo = (() => {
    const date = new Date(`${monthStart}T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() - 5);
    return date.toISOString().slice(0, 10);
  })();
  const trend = useQuery({
    queryKey: ['report-income', sixMonthsAgo, today()],
    queryFn: () => api.get<{ months: MonthTotal[] }>(`/reports/income-expense?from=${sixMonthsAgo}&to=${today()}`),
  });
  const thisMonth = trend.data?.months.at(-1);
  const month = { data: thisMonth ? { totals: thisMonth } : undefined };
  const slips = useQuery({
    queryKey: ['payment-proofs'],
    queryFn: () => api.get<{ items: { id: string }[] }>('/payment-proofs'),
  });
  const applications = useQuery({
    queryKey: ['applications'],
    queryFn: () => api.get<{ items: { id: string; status: string }[] }>('/applications'),
  });
  const imports = useQuery({
    queryKey: ['bank-imports'],
    queryFn: () => api.get<{ items: { unmatched: number }[] }>('/bank-imports'),
  });
  const tickets = useQuery({
    queryKey: ['tickets'],
    queryFn: () => api.get<{ items: { id: string; title: string; unit: string; status: string; overdue: boolean }[] }>('/tickets'),
  });

  // Where each debt stands on the arrears ladder, so the dashboard says when a letter is due.
  const ladder = useQuery({
    queryKey: ['report-arrears'],
    queryFn: () =>
      api.get<{ items: { leaseId: string; stage: string | null; pausedUntil: string | null }[] }>('/reports/arrears'),
  });

  const privacy = useQuery({
    queryKey: ['privacy-requests'],
    queryFn: () => api.get<{ items: { status: string }[] }>('/privacy-requests'),
  });

  if (!leases.data) {
    return (
      <QueryState
        isLoading={leases.isLoading}
        isError={leases.isError}
        error={leases.error}
        onRetry={leases.refetch}
        what="Your units"
      />
    );
  }

  const rows = leases.data?.items ?? [];
  const arrears = rows.reduce((sum, lease) => sum + lease.outstandingCents, 0);
  const owing = rows.filter((lease) => lease.outstandingCents > 0).length;
  const slipCount = slips.data?.items.length ?? 0;
  const waiting = applications.data?.items.filter((item) => ['submitted', 'screening'].includes(item.status)).length ?? 0;
  const unmatched = imports.data?.items.reduce((sum, item) => sum + item.unmatched, 0) ?? 0;
  const openTickets = tickets.data?.items.filter((ticket) => !['done', 'closed', 'cancelled'].includes(ticket.status)) ?? [];
  const lateTickets = openTickets.filter((ticket) => ticket.overdue);

  const stageOf = new Map((ladder.data?.items ?? []).map((item) => [item.leaseId, item]));
  const letterReady = rows.filter((lease) => {
    const stage = stageOf.get(lease.id);
    return lease.outstandingCents > 0 && stage?.stage === 'reminder_7' && !stage.pausedUntil;
  });

  const tasks: Task[] = [];
  for (const lease of letterReady.slice(0, 3)) {
    tasks.push({
      key: `letter-${lease.id}`, to: `/leases/${lease.id}`, tone: 'danger',
      title: `Letter of demand ready: ${lease.tenant}`,
      detail: `${lease.unit}, ${zar(lease.outstandingCents)}, final reminder sent.`,
    });
  }
  if (slipCount > 0) {
    tasks.push({
      key: 'slips', to: '/payments', tone: 'warning',
      title: `${slipCount} proof${slipCount === 1 ? '' : 's'} of payment to check`,
      detail: 'Accept once the money shows in your account.',
    });
  }
  if (unmatched > 0) {
    tasks.push({
      key: 'bank', to: '/payments', tone: 'info',
      title: `${unmatched} bank ${unmatched === 1 ? 'line' : 'lines'} to match`,
      detail: 'From a statement you imported.',
    });
  }
  for (const ticket of lateTickets.slice(0, 3)) {
    tasks.push({
      key: `ticket-${ticket.id}`, to: `/tickets/${ticket.id}`, tone: 'danger',
      title: `Overdue: ${ticket.title}`, detail: `${ticket.unit}, past its response target.`,
    });
  }
  const ready = new Set(letterReady.map((lease) => lease.id));
  for (const lease of [...rows].filter((l) => l.outstandingCents > 0 && !ready.has(l.id)).sort((a, b) => b.outstandingCents - a.outstandingCents).slice(0, 3)) {
    const stage = stageOf.get(lease.id);
    tasks.push({
      key: `arrears-${lease.id}`, to: `/leases/${lease.id}`, tone: 'danger',
      title: `${lease.tenant} owes ${zar(lease.outstandingCents)}`,
      detail: [lease.unit, stage?.pausedUntil ? `reminders paused to ${formatDate(stage.pausedUntil)}` : stage?.stage ? STAGE[stage.stage] : null]
        .filter(Boolean)
        .join(', '),
    });
  }
  const privacyWaiting = privacy.data?.items.filter((item) => item.status === 'pending').length ?? 0;
  if (privacyWaiting > 0) {
    tasks.push({
      key: 'privacy', to: '/settings/notifications', tone: 'warning',
      title: `${privacyWaiting} privacy request${privacyWaiting === 1 ? '' : 's'} to answer`,
      detail: 'POPIA expects an answer within a reasonable time.',
    });
  }
  if (waiting > 0) {
    tasks.push({
      key: 'applications', to: '/applications', tone: 'info',
      title: `${waiting} application${waiting === 1 ? '' : 's'} waiting`, detail: 'Read the paperwork and decide.',
    });
  }
  for (const lease of rows) {
    if (lease.terminationEffectiveOn) {
      const days = daysUntil(lease.terminationEffectiveOn);
      if (days >= 0 && days <= 30) {
        tasks.push({
          key: `exit-${lease.id}`, to: `/leases/${lease.id}`, tone: 'warning',
          title: `${lease.unit} ends ${formatDate(lease.terminationEffectiveOn)}`,
          detail: 'Book the exit inspection for the last three days, with the tenant there.',
        });
      }
      continue;
    }
    const days = daysUntil(lease.endDate);
    if (!lease.renewalOffered && days >= 0 && days <= 60) {
      tasks.push({
        key: `renew-${lease.id}`, to: `/leases/${lease.id}`, tone: 'info',
        title: `${lease.unit} ends in ${days} days`, detail: 'Offer a renewal, or plan the exit.',
      });
    }
  }

  return (
    <main className={PAGE.wide}>
      <PageHeader title="Overview" description={`${rows.length} lease${rows.length === 1 ? '' : 's'} running.`} />
      <SetupChecklist />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Collected this month" value={month.data ? <Money whole cents={month.data.totals.collectedCents} /> : '...'}
          hint={month.data ? `of ${headlineZar(month.data.totals.invoicedCents)} invoiced` : undefined} />
        <Stat label="Arrears" value={<Money whole cents={arrears} />} danger={arrears > 0}
          hint={owing > 0 ? `${owing} tenant${owing === 1 ? '' : 's'} owing` : 'Nobody owes anything'} to="/reports" />
        <Stat label="Slips to check" value={String(slipCount)} to="/payments" />
        <Stat label="Open maintenance" value={String(openTickets.length)}
          hint={lateTickets.length > 0 ? `${lateTickets.length} overdue` : undefined} danger={lateTickets.length > 0} to="/tickets" />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="space-y-6">
        <section>
          <h2 className="label mb-2">Needs you</h2>
          {tasks.length === 0 ? (
            <Card>
              <CardBody>
                <p className="text-lead font-semibold text-ink">All clear</p>
                <p className="text-meta text-ink-muted">No payments to check, no arrears, nothing overdue.</p>
              </CardBody>
            </Card>
          ) : (
            <Card>
              <ul className="divide-y divide-line-soft">
                {tasks.map((task) => (
                  <li key={task.key}>
                    <Link to={task.to} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-muted">
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${
                          task.tone === 'danger' ? 'bg-danger' : task.tone === 'warning' ? 'bg-warning' : 'bg-info'
                        }`}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-body font-semibold text-ink">{task.title}</span>
                        <span className="block text-xs text-ink-muted">{task.detail}</span>
                      </span>
                      <ChevronRightIcon className="shrink-0 text-ink-muted" />
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </section>
        {trend.data && trend.data.months.some((m) => m.invoicedCents > 0) ? <CollectionsChart months={trend.data.months} /> : null}
        </div>

        <LeaseList rows={rows} />
      </div>
    </main>
  );
}

function Stat({ label, value, hint, danger, to }: { label: string; value: React.ReactNode; hint?: string; danger?: boolean; to?: string }) {
  const body = (
    <Card className="h-full">
      <CardBody>
        <p className="text-xs text-ink-muted">{label}</p>
        <p className={`font-display text-figure font-medium leading-tight ${danger ? 'text-danger' : 'text-ink'}`}>{value}</p>
        {hint ? <p className="text-xs text-ink-muted">{hint}</p> : null}
      </CardBody>
    </Card>
  );
  return to ? <Link to={to} className="block">{body}</Link> : body;
}

/** A table on a laptop, a compact list on a phone. Search appears once the list is long. */
function LeaseList({ rows }: { rows: LeaseRow[] }) {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const needle = search.trim().toLowerCase();
  const shown = needle
    ? rows.filter((lease) => `${lease.unit} ${lease.tenant} ${lease.ref}`.toLowerCase().includes(needle))
    : rows;

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="label">Leases</h2>
        <span className="flex gap-4">
          <Link to="/tenants/import" className="inline-flex min-h-6 items-center text-xs font-bold text-brand-500">Add current tenants</Link>
          <Link to="/properties" className="inline-flex min-h-6 items-center text-xs font-bold text-brand-500">Properties</Link>
        </span>
      </div>
      {rows.length > 6 ? (
        <Input
          className="mb-3"
          placeholder="Search unit, tenant or reference"
          aria-label="Search leases"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      ) : null}
      {rows.length === 0 ? (
        <EmptyState
          title="No leases yet"
          description="A lease appears here once it is signed, or as soon as you add a tenant who is renting already."
        />
      ) : shown.length === 0 ? (
        <p className="text-meta text-ink-muted">No lease matches "{search}".</p>
      ) : (
        <Card>
          {/* Phone: one tappable row per lease. */}
          <ul className="divide-y divide-line-soft md:hidden">
            {shown.map((lease) => (
              <li key={lease.id}>
                <Link to={`/leases/${lease.id}`} className="flex items-center gap-3 px-4 py-3">
                  {/* Two lines that never cut the rent off: unit and rent, then tenant and state. */}
                  <span className="min-w-0 flex-1 space-y-0.5">
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-body font-semibold text-ink">{lease.unit}</span>
                      <Money cents={lease.monthlyRentCents} className="shrink-0 text-body" />
                    </span>
                    <span className="flex items-center justify-between gap-3">
                      <span className="truncate text-xs text-ink-muted">{lease.tenant}</span>
                      <LeaseFlag lease={lease} />
                    </span>
                  </span>
                  <ChevronRightIcon className="shrink-0 text-ink-muted" />
                </Link>
              </li>
            ))}
          </ul>
          {/* Laptop: everything on one line, sortable by eye. */}
          <div className="hidden overflow-x-auto md:block">
          <table className="w-full text-left text-meta">
            <thead>
              <tr className="border-b border-line-soft text-xs text-ink-muted">
                <th className="px-4 py-2 font-semibold">Unit</th>
                <th className="px-4 py-2 font-semibold">Tenant</th>
                <th className="px-4 py-2 text-right font-semibold">Rent</th>
                <th className="px-4 py-2 text-right font-semibold">Owing</th>
                <th className="px-4 py-2 font-semibold">Ends</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {shown.map((lease) => (
                <tr
                  key={lease.id}
                  className="cursor-pointer hover:bg-surface-muted"
                  onClick={() => navigate(`/leases/${lease.id}`)}
                >
                  <td className="px-4 py-2.5">
                    <Link to={`/leases/${lease.id}`} className="inline-flex min-h-6 items-center whitespace-nowrap font-semibold text-ink">{lease.unit}</Link>
                    <span className="block whitespace-nowrap text-xs text-ink-muted">{lease.ref}</span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5">{lease.tenant}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right"><Money cents={lease.monthlyRentCents} /></td>
                  <td className={`whitespace-nowrap px-4 py-2.5 text-right tabular-nums ${lease.outstandingCents > 0 ? 'font-semibold text-danger' : 'text-ink-muted'}`}>
                    {lease.outstandingCents > 0 ? zar(lease.outstandingCents) : '-'}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5">
                    {formatDate(lease.terminationEffectiveOn ?? lease.endDate)}
                    {endNote(lease) ? <span className="block text-xs font-semibold text-warning">{endNote(lease)}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </Card>
      )}
    </section>
  );
}

/** The one thing worth knowing about a lease at a glance, or its status when nothing stands out. */
/** What is coming up at the end of a lease, for the table's Ends column. */
function endNote(lease: LeaseRow): string | null {
  if (lease.terminationEffectiveOn) return 'Notice served';
  if (lease.renewalOffered) return 'Renewal offered';
  const days = daysUntil(lease.endDate);
  return days >= 0 && days <= 60 ? `In ${days} days` : null;
}

function LeaseFlag({ lease }: { lease: LeaseRow }) {
  if (lease.outstandingCents > 0) return <Badge tone="danger">Owes {zar(lease.outstandingCents)}</Badge>;
  if (lease.terminationEffectiveOn) return <Badge tone="warning">Notice served</Badge>;
  if (lease.renewalOffered) return <Badge tone="info">Renewal offered</Badge>;
  const days = daysUntil(lease.endDate);
  if (days >= 0 && days <= 60) return <Badge tone="warning">Ends in {days} days</Badge>;
  if (lease.status !== 'active') {
    const shown = status(lease.status);
    return <Badge tone={shown.tone}>{shown.label}</Badge>;
  }
  return <Badge tone="success">Paid up</Badge>;
}
