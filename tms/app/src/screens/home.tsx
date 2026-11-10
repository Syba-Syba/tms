import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { Avatar, Badge, Button, Input, Modal } from '@hlonie/toolbox/ui';
import { formatZar } from '@hlonie/toolbox/utils';
import { api } from '../api/client';
import { daysUntil, formatDate, headlineZar, status } from '../lib/format';
import { QueryState } from '../components/query-state';
import { SetupChecklist } from '../components/setup-checklist';
import { currentUser, isLandlord } from '../lib/session';
import { localToday } from '../lib/dates';
import { useLandlord } from '../lib/landlord';
import { TenantHome } from './tenant-home';
import { PAGE } from '../lib/layout';
import { Money } from '../components/money';
import { CollectionsChart, type MonthTotal } from '../components/collections-chart';
import { ActionLink, NAV_LINK, ROWS, SectionCard, ShareBar, StatTile, StateMark } from '../components/core-kit';

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
  /** Of outstandingCents, what is past its due date. Rent issued on the 25th is not late yet. */
  overdueCents: number;
  previousLeaseId: string | null;
  terminationId: string | null;
  awaitingTenant?: boolean;
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
  /** One or two characters in the tinted square: a count, days left, R for money. */
  mark: string;
  /** What tapping the row does, said as a verb. */
  action: string;
}

// Whole rands read faster in a list; cents show only when there are any.
const zar = (cents: number) => formatZar(cents / 100, cents % 100 !== 0);

const STAGE: Record<string, string> = {
  reminder_1: 'first reminder sent',
  reminder_3: 'second reminder sent',
  reminder_7: 'final reminder sent',
  letter_of_demand: 'letter of demand sent',
};
// The device's calendar (SAST for our users), not UTC: before 02:00 UTC was still yesterday.
const today = localToday;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const LONG_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
/** "2026-11-10" as "Tuesday 10 November". */
const longDay = (iso: string) => {
  const [year, month, day] = iso.split('-').map(Number) as [number, number, number];
  return `${WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]} ${day} ${LONG_MONTHS[month - 1]}`;
};
/** The greeting for the hour in Johannesburg, where the landlord's day runs. */
const greeting = (now: Date = new Date()) => {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Johannesburg', hour: '2-digit', hour12: false }).format(now)) % 24;
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
};

/** The tone a lease's row and avatar take: owing, ending soon, or fine. */
const leaseTone = (lease: LeaseRow): 'danger' | 'warning' | 'success' | undefined => {
  if (lease.overdueCents > 0) return 'danger';
  if (lease.terminationEffectiveOn) return 'warning';
  const days = daysUntil(lease.endDate);
  if (lease.status === 'active' && days <= 60) return 'warning';
  return lease.status === 'active' ? 'success' : undefined;
};

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

  // For occupancy only. The same cache the Properties screen fills.
  const properties = useQuery({
    queryKey: ['properties'],
    queryFn: () => api.get<{ items: { units: { status: string }[] }[] }>('/properties'),
  });
  const [choosing, setChoosing] = useState(false);

  const landlordAccount = useLandlord();
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
  // Behind means past the due date. Next month's rent is issued on the 25th; counting it made
  // every tenant look behind until the 1st.
  const arrears = rows.reduce((sum, lease) => sum + lease.overdueCents, 0);
  const notYetDue = rows.reduce((sum, lease) => sum + Math.max(0, lease.outstandingCents - lease.overdueCents), 0);
  const owing = rows.filter((lease) => lease.overdueCents > 0).length;
  // A renewal or a new tenancy waiting to start is not a lease running yet.
  const running = rows.filter((lease) => lease.status === 'active').length;
  // Leases already followed by a scheduled renewal: no "Offer a renewal" prompt for them.
  const renewed = new Set(
    rows.filter((lease) => lease.status === 'scheduled' && lease.previousLeaseId).map((lease) => lease.previousLeaseId!),
  );
  const slipCount = slips.data?.items.length ?? 0;
  const waiting = applications.data?.items.filter((item) => ['submitted', 'screening'].includes(item.status)).length ?? 0;
  const unmatched = imports.data?.items.reduce((sum, item) => sum + item.unmatched, 0) ?? 0;
  const openTickets = tickets.data?.items.filter((ticket) => !['done', 'closed', 'cancelled'].includes(ticket.status)) ?? [];
  const lateTickets = openTickets.filter((ticket) => ticket.overdue);

  const stageOf = new Map((ladder.data?.items ?? []).map((item) => [item.leaseId, item]));
  const letterReady = rows.filter((lease) => {
    const stage = stageOf.get(lease.id);
    return lease.overdueCents > 0 && stage?.stage === 'reminder_7' && !stage.pausedUntil;
  });

  const tasks: Task[] = [];
  for (const lease of letterReady.slice(0, 3)) {
    tasks.push({
      key: `letter-${lease.id}`, to: `/leases/${lease.id}`, tone: 'danger', mark: 'R', action: 'Review',
      title: `Letter of demand ready: ${lease.tenant}`,
      detail: `${lease.unit}, ${zar(lease.overdueCents)}, final reminder sent.`,
    });
  }
  if (slipCount > 0) {
    tasks.push({
      key: 'slips', to: '/payments', tone: 'warning', mark: String(slipCount), action: 'Check',
      title: `${slipCount} proof${slipCount === 1 ? '' : 's'} of payment to check`,
      detail: 'Accept once the money shows in your account.',
    });
  }
  if (unmatched > 0) {
    tasks.push({
      key: 'bank', to: '/payments', tone: 'info', mark: String(unmatched), action: 'Match',
      title: `${unmatched} bank ${unmatched === 1 ? 'line' : 'lines'} to match`,
      detail: 'From a statement you imported.',
    });
  }
  for (const ticket of lateTickets.slice(0, 3)) {
    tasks.push({
      key: `ticket-${ticket.id}`, to: `/tickets/${ticket.id}`, tone: 'danger', mark: '!', action: 'Open',
      title: `Overdue: ${ticket.title}`, detail: `${ticket.unit}, past its response target.`,
    });
  }
  const ready = new Set(letterReady.map((lease) => lease.id));
  for (const lease of [...rows].filter((l) => l.overdueCents > 0 && !ready.has(l.id)).sort((a, b) => b.overdueCents - a.overdueCents).slice(0, 3)) {
    const stage = stageOf.get(lease.id);
    tasks.push({
      key: `arrears-${lease.id}`, to: `/leases/${lease.id}`, tone: 'danger', mark: 'R', action: 'Follow up',
      title: `${lease.tenant} owes ${zar(lease.overdueCents)}`,
      detail: [lease.unit, stage?.pausedUntil ? `reminders paused to ${formatDate(stage.pausedUntil)}` : stage?.stage ? STAGE[stage.stage] : null]
        .filter(Boolean)
        .join(', '),
    });
  }
  const privacyWaiting = privacy.data?.items.filter((item) => item.status === 'pending').length ?? 0;
  if (privacyWaiting > 0) {
    // Only the owner can answer one; an agent who tapped Erase was refused.
    const owner = landlordAccount.data?.me.role === 'owner';
    tasks.push({
      key: 'privacy', to: '/settings/notifications', tone: 'warning', mark: String(privacyWaiting), action: owner ? 'Answer' : 'View',
      title: `${privacyWaiting} privacy request${privacyWaiting === 1 ? '' : 's'} ${owner ? 'to answer' : 'waiting'}`,
      detail: owner
        ? 'POPIA expects an answer within a reasonable time.'
        : 'Only the account owner can answer. Ask them to, as POPIA expects an answer within a reasonable time.',
    });
  }
  if (waiting > 0) {
    tasks.push({
      key: 'applications', to: '/applications', tone: 'info', mark: String(waiting), action: 'Review',
      title: `${waiting} application${waiting === 1 ? '' : 's'} waiting`, detail: 'Read the paperwork and decide.',
    });
  }
  for (const lease of rows) {
    if (lease.terminationEffectiveOn) {
      const days = daysUntil(lease.terminationEffectiveOn);
      // Said whatever the date: settling is refused until the tenant confirms the notice the
      // landlord recorded. It used to sit behind the exit-inspection task, so in the usual case
      // (a notice about four weeks out) the landlord never saw it.
      if (lease.awaitingTenant) {
        tasks.push({
          key: `confirm-${lease.id}`, to: `/leases/${lease.id}`, tone: 'warning', mark: '?', action: 'View',
          title: `${lease.unit}: waiting for the tenant to confirm the notice`,
          detail: 'The deposit can be settled once the tenant confirms it in the app.',
        });
      }
      if (days >= 0 && days <= 30) {
        tasks.push({
          key: `exit-${lease.id}`, to: `/leases/${lease.id}`, tone: 'warning', mark: String(days), action: 'Book',
          title: `${lease.unit} ends ${formatDate(lease.terminationEffectiveOn)}`,
          detail: 'Book the exit inspection for the last three days, with the tenant there.',
        });
      } else if (days < 0 && !lease.awaitingTenant) {
        // Still listed, so not settled: settling ends the lease. The refund deadline is running.
        tasks.push({
          key: `settle-${lease.id}`,
          to: lease.terminationId ? `/terminations/${lease.terminationId}` : `/leases/${lease.id}`,
          tone: 'danger', mark: 'R', action: 'Settle',
          title: `Settle the deposit for ${lease.unit}`,
          detail: `The lease ended ${formatDate(lease.terminationEffectiveOn)}. The Rental Housing Act refund deadline is running.`,
        });
      }
      continue;
    }
    const days = daysUntil(lease.endDate);
    if (lease.status !== 'active') continue;
    if (!lease.renewalOffered && !renewed.has(lease.id) && days >= 0 && days <= 60) {
      tasks.push({
        key: `renew-${lease.id}`, to: `/leases/${lease.id}`, tone: 'info', mark: String(days), action: 'Renew',
        title: `${lease.unit} ends in ${days} days`, detail: `${lease.tenant}. Offer a renewal, or plan the exit.`,
      });
    } else if (days < 0 && !renewed.has(lease.id)) {
      // Past its end date with no notice: it runs month to month until someone acts.
      tasks.push({
        key: `runout-${lease.id}`, to: `/leases/${lease.id}`, tone: 'warning', mark: '!', action: 'Decide',
        title: `${lease.unit} is past its end date`,
        detail: `It ended ${formatDate(lease.endDate)} and now runs month to month. Offer a renewal or record a notice.`,
      });
    }
  }

  const units = properties.data?.items.flatMap((property) => property.units) ?? null;
  const vacant = units?.filter((unit) => unit.status === 'vacant').length ?? 0;
  const occupied = units?.filter((unit) => unit.status === 'occupied').length ?? 0;
  const depositsHeld = rows.reduce((sum, lease) => sum + lease.depositBalanceCents, 0);
  const firstName = currentUser()?.name?.trim().split(/\s+/)[0];
  // Money is recorded on a lease, so "Record a payment" asks which one when there are several.
  const payable = rows.filter((lease) => lease.status === 'active');
  const owingRow = owing === 1 ? rows.find((lease) => lease.overdueCents > 0) : undefined;
  const monthName = LONG_MONTHS[Number(today().slice(5, 7)) - 1];
  const collectedCents = thisMonth?.collectedCents;
  const invoicedCents = thisMonth?.invoicedCents;
  const repairs = `${openTickets.length} open repair${openTickets.length === 1 ? '' : 's'}${lateTickets.length > 0 ? `, ${lateTickets.length} overdue` : ''}`;

  return (
    <main className={PAGE.wide}>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-display text-display font-bold leading-tight tracking-[-0.01em] text-ink">
            {greeting()}{firstName ? `, ${firstName}` : ''}
          </h1>
          <p className="mt-1 text-body text-ink-muted">
            {longDay(today())} · {running} lease{running === 1 ? '' : 's'} running
            {units ? `, ${vacant} unit${vacant === 1 ? '' : 's'} vacant` : ''}
          </p>
        </div>
        {payable.length === 1 ? (
          <ActionLink variant="primary" to={`/leases/${payable[0]!.id}?pay=1`}>Record a payment</ActionLink>
        ) : payable.length > 1 ? (
          <Button onClick={() => setChoosing(true)}>Record a payment</Button>
        ) : (
          <ActionLink variant="primary" to="/tenants/import">Add current tenants</ActionLink>
        )}
      </header>

      <SetupChecklist />

      <section aria-label="This month" className="mb-6 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-[1.25fr_1fr_1fr_1fr]">
        <div className="col-span-2 lg:col-span-1">
          <StatTile
            to="/reports"
            tone={arrears > 0 ? 'danger' : 'plain'}
            label="Overdue rent"
            value={<Money whole cents={arrears} />}
            note={
              <>
                {arrears > 0
                  ? owingRow ? `${owingRow.tenant} is behind on rent.` : `${owing} tenants behind on rent.`
                  : 'Nobody is behind.'}
                {notYetDue > 0 ? ` ${headlineZar(notYetDue)} more is invoiced and not yet due.` : ''}
              </>
            }
          />
        </div>
        <StatTile
          to="/payments"
          label={`Collected in ${monthName}`}
          value={collectedCents === undefined ? '...' : <Money whole cents={collectedCents} />}
          note={invoicedCents === undefined ? 'Loading this month.' : `of ${headlineZar(invoicedCents)} invoiced`}
        >
          {collectedCents !== undefined && invoicedCents ? (
            <ShareBar value={collectedCents} max={invoicedCents} label={`Share of ${monthName} rent collected`} />
          ) : null}
        </StatTile>
        {units ? (
          <StatTile
            to="/properties"
            label="Occupancy"
            value={`${occupied} of ${units.length}`}
            note={vacant === 0 ? 'No units vacant.' : `${vacant} unit${vacant === 1 ? '' : 's'} vacant`}
          />
        ) : (
          <StatTile to="/properties" label="Leases running" value={String(running)} note={`${rows.length} on the books`} />
        )}
        <div className="col-span-2 sm:col-span-1">
          <StatTile
            label="Deposits held"
            value={<Money whole cents={depositsHeld} />}
            note={`across ${rows.length} lease${rows.length === 1 ? '' : 's'}`}
          />
        </div>
      </section>

      {/* Phone: tasks, leases, then the chart. Laptop: tasks and the chart on the left, leases on the right. */}
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:grid-rows-[auto_1fr]">
          <SectionCard title="To do today" className="lg:col-start-1 lg:row-start-1" count={tasks.length > 0 ? tasks.length : undefined}>
            {tasks.length === 0 ? (
              <div className="px-5 py-5">
                <p className="text-body font-bold text-ink">All clear</p>
                <p className="mt-0.5 text-meta text-ink-muted">
                  No payments to check, no arrears, nothing overdue. Tasks appear here when a tenant pays, applies or
                  falls behind.
                </p>
              </div>
            ) : (
              <ul className={ROWS}>
                {tasks.map((task) => (
                  <li key={task.key}>
                    <Link
                      to={task.to}
                      className="flex items-center gap-3.5 px-5 py-3.5 hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--tb-ring)]"
                    >
                      <StateMark tone={task.tone}>{task.mark}</StateMark>
                      <span className="min-w-0 flex-1">
                        <span className="block text-body font-bold text-ink">{task.title}</span>
                        <span className="block text-meta text-ink-muted">{task.detail}</span>
                      </span>
                      <span className="inline-flex h-9 shrink-0 items-center rounded-sm bg-brand-50 px-3.5 text-meta font-semibold text-brand-600">
                        {task.action}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <p className="flex flex-wrap gap-x-5 gap-y-1 border-t border-line-soft px-5 py-3">
              <Link to="/payments" className={NAV_LINK}>{slipCount} slip{slipCount === 1 ? '' : 's'} to check</Link>
              <Link to="/tickets" className={NAV_LINK}>{repairs}</Link>
            </p>
          </SectionCard>

        <LeaseList rows={rows} />

        {trend.data && trend.data.months.some((m) => m.invoicedCents > 0) ? (
          <div className="min-w-0 lg:col-start-1 lg:row-start-2"><CollectionsChart months={trend.data.months} /></div>
        ) : null}
      </div>

      <Modal
        open={choosing}
        onOpenChange={setChoosing}
        title="Record a payment"
        description="Choose whose payment it is. You enter the amount on their lease."
      >
        <ul className="-mx-2 divide-y divide-line-soft">
          {payable.map((lease) => (
            <li key={lease.id}>
              <Link
                to={`/leases/${lease.id}?pay=1`}
                className="flex items-center gap-3 rounded-sm px-2 py-3 hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--tb-ring)]"
              >
                <Avatar name={lease.tenant} tone={leaseTone(lease)} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body font-bold text-ink">{lease.tenant}</span>
                  <span className="block truncate text-meta text-ink-muted">{lease.unit}</span>
                </span>
                {lease.outstandingCents > 0 ? (
                  <Badge tone={lease.overdueCents > 0 ? 'danger' : 'neutral'}>{zar(lease.outstandingCents)} open</Badge>
                ) : (
                  <Badge tone="success">Paid up</Badge>
                )}
              </Link>
            </li>
          ))}
        </ul>
      </Modal>
    </main>
  );
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
    <SectionCard
      title="Leases"
      className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1"
      action={
        <span className="flex flex-wrap gap-x-5">
          <Link to="/tenants/import" className={NAV_LINK}>Add current tenants</Link>
          <Link to="/properties" className={NAV_LINK}>All properties</Link>
        </span>
      }
    >
      {rows.length > 6 ? (
        <div className="border-b border-line-soft px-5 py-3">
          <Input
            placeholder="Search unit, tenant or reference"
            aria-label="Search leases"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      ) : null}
      {rows.length === 0 ? (
        <div className="px-5 py-6">
          <p className="text-body font-bold text-ink">No leases yet</p>
          <p className="mt-0.5 max-w-prose text-meta text-ink-muted">
            A lease appears here once it is signed, or as soon as you add a tenant who is renting already.
          </p>
          <ActionLink variant="secondary" size="sm" to="/tenants/import" className="mt-4">Add a tenant who rents already</ActionLink>
        </div>
      ) : shown.length === 0 ? (
        <p className="px-5 py-5 text-meta text-ink-muted">No lease matches "{search}".</p>
      ) : (
        <>
          {/* Phone: one tappable row per lease. */}
          <ul className={`${ROWS} md:hidden`}>
            {shown.map((lease) => (
              <li key={lease.id}>
                <Link to={`/leases/${lease.id}`} className="flex items-center gap-3 px-5 py-3.5">
                  <Avatar name={lease.tenant} tone={leaseTone(lease)} />
                  {/* Two lines that never cut the rent off: tenant and rent, then unit and state. */}
                  <span className="min-w-0 flex-1 space-y-1">
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-body font-bold text-ink">{lease.tenant}</span>
                      <Money cents={lease.monthlyRentCents} whole className="shrink-0 text-body" />
                    </span>
                    <span className="flex items-center justify-between gap-3">
                      <span className="truncate text-meta text-ink-muted">{lease.unit}</span>
                      <LeaseFlag lease={lease} />
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {/* Laptop: everything on one line, sortable by eye. */}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-left text-body">
              <thead>
                <tr className="border-b border-line-soft text-meta text-ink-muted">
                  <th className="px-5 py-3 font-semibold">Tenant</th>
                  <th className="px-3 py-3 text-right font-semibold">Rent</th>
                  <th className="px-3 py-3 font-semibold">Ends</th>
                  <th className="px-5 py-3 text-right font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {shown.map((lease) => (
                  <tr
                    key={lease.id}
                    className="cursor-pointer hover:bg-surface-muted"
                    onClick={() => navigate(`/leases/${lease.id}`)}
                  >
                    <td className="px-5 py-3.5">
                      <span className="flex items-center gap-3">
                        <Avatar name={lease.tenant} tone={leaseTone(lease)} />
                        <span className="min-w-0">
                          <Link
                            to={`/leases/${lease.id}`}
                            className="block whitespace-nowrap font-bold text-ink hover:underline"
                            onClick={(event) => event.stopPropagation()}
                          >
                            {lease.tenant}
                          </Link>
                          <span className="block whitespace-nowrap text-meta text-ink-muted">{lease.unit}</span>
                        </span>
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3.5 text-right"><Money cents={lease.monthlyRentCents} whole /></td>
                    <td className="whitespace-nowrap px-3 py-3.5 text-meta text-ink">
                      {formatDate(lease.terminationEffectiveOn ?? lease.endDate)}
                    </td>
                    <td className="whitespace-nowrap px-5 py-3.5 text-right">
                      <LeaseFlag lease={lease} />
                      {lease.outstandingCents > lease.overdueCents ? (
                        <span className="mt-1 block text-xs text-ink-muted">
                          {zar(lease.outstandingCents - lease.overdueCents)} not yet due
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </SectionCard>
  );
}

/** The one thing worth knowing about a lease at a glance, or its status when nothing stands out. */
function LeaseFlag({ lease }: { lease: LeaseRow }) {
  if (lease.overdueCents > 0) return <Badge tone="danger">Owes {zar(lease.overdueCents)}</Badge>;
  if (lease.terminationEffectiveOn) return <Badge tone="warning">Notice served</Badge>;
  if (lease.renewalOffered) return <Badge tone="info">Renewal offered</Badge>;
  if (lease.status !== 'active') {
    const shown = status(lease.status);
    return <Badge tone={shown.tone}>{shown.label}</Badge>;
  }
  const days = daysUntil(lease.endDate);
  if (days < 0) return <Badge tone="warning">Month to month</Badge>;
  if (days <= 60) return <Badge tone="warning">Ends in {days} days</Badge>;
  return <Badge tone="success">Paid up</Badge>;
}
