import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Avatar, Badge, Button, Card, EmptyState, Modal, PageHeader, SegmentedControl, Select, Spinner } from '@hlonie/toolbox/ui';
import { api } from '../api/client';
import { Money } from '../components/money';
import { QueryError } from '../components/query-state';
import { isLandlord } from '../lib/session';
import { capitalise, formatDateTime, status as statusOf } from '../lib/format';
import { PAGE } from '../lib/layout';

interface Ticket {
  id: string;
  title: string;
  category: string;
  severity: 'emergency' | 'urgent' | 'routine';
  status: string;
  unit: string;
  contractor: string | null;
  quoteCents: number | null;
  rating: number | null;
  targetBy: string;
  overdue: boolean;
}

interface LeaseChoice { id: string; status: string; unit: string; tenant?: string }

const severityTone = { emergency: 'danger', urgent: 'warning', routine: 'neutral' } as const;
/** The round marker at the start of a card: tinted by how serious it is, lettered by category. */
const MARKER = {
  emergency: 'bg-tint-danger text-[var(--tb-danger-ink)]',
  urgent: 'bg-tint-warning text-[var(--tb-warning-ink)]',
  routine: 'bg-brand-50 text-brand-700',
} as const;

export function TicketsList() {
  const navigate = useNavigate();
  const landlord = isLandlord();
  const [status, setStatus] = useState<'active' | 'closed'>('active');
  const [picking, setPicking] = useState(false);
  const [leaseId, setLeaseId] = useState('');
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['tickets', status],
    queryFn: () => api.get<{ items: Ticket[] }>('/tickets', { query: { status } }),
  });
  // A repair hangs off a lease: a tenant has one, a landlord picks which.
  const { data: leases } = useQuery({
    queryKey: ['leases'],
    queryFn: () => api.get<{ items: LeaseChoice[] }>('/leases'),
  });
  const running = (leases?.items ?? []).filter((lease) => lease.status === 'active');

  const items = data?.items ?? [];
  const overdue = items.filter((ticket) => ticket.overdue).length;
  const waitingOnTenant = items.filter((ticket) => ticket.status === 'done').length;
  const toApprove = items.filter((ticket) => ticket.status === 'quote_pending').length;

  const report = () => {
    if (!landlord && running.length === 1) {
      navigate(`/leases/${running[0]!.id}/tickets/new`);
      return;
    }
    setLeaseId(running.length === 1 ? running[0]!.id : '');
    setPicking(true);
  };
  const reportLabel = landlord ? 'Log a repair' : 'Report a problem';
  const canReport = running.length > 0;

  return (
    <main className={PAGE.wide}>
      <PageHeader
        title="Repairs"
        description={
          landlord
            ? 'Everything reported across your units.'
            : 'Problems you have reported, and where they stand.'
        }
        actions={canReport ? <Button onClick={report}>{reportLabel}</Button> : undefined}
      />

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div>
          <div className="mb-4 max-w-xs">
            <SegmentedControl
              value={status}
              onChange={setStatus}
              options={[
                { label: 'Open', value: 'active' },
                { label: 'Closed', value: 'closed' },
              ]}
            />
          </div>

          {isLoading ? <Spinner /> : null}

          {isError ? <QueryError error={error} onRetry={refetch} what="The list" /> : null}

          {!isLoading && !isError && items.length === 0 ? (
            <EmptyState
              title={status === 'active' ? 'Nothing outstanding' : 'Nothing closed yet'}
              description={
                status === 'active'
                  ? landlord
                    ? 'When a tenant reports a problem it appears here. You can also log one yourself.'
                    : 'When something breaks, report it with a photo and it appears here.'
                  : 'Closed repairs keep their history and rating.'
              }
              action={
                status === 'active' && canReport ? (
                  <Button variant="secondary" className="mt-1" onClick={report}>{reportLabel}</Button>
                ) : undefined
              }
            />
          ) : null}

          <ul className="space-y-3">
            {items.map((ticket) => (
              <li key={ticket.id}>
                <Card className="relative transition-colors hover:bg-surface-muted">
                  <div className="flex items-start gap-3.5 px-5 py-4">
                    <span
                      aria-hidden
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-body font-bold ${MARKER[ticket.severity]}`}
                    >
                      {ticket.category.charAt(0).toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                        {/* The list is the only way into a ticket that is not overdue. The link
                            stretches over the whole card. */}
                        <Link
                          to={`/tickets/${ticket.id}`}
                          className="text-lead font-bold text-ink after:absolute after:inset-0 after:rounded-md focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-[var(--tb-ring)]"
                        >
                          {ticket.title}
                        </Link>
                        <div className="flex flex-wrap items-center gap-2">
                          {ticket.severity !== 'routine' ? (
                            <Badge tone={severityTone[ticket.severity]}>{capitalise(ticket.severity)}</Badge>
                          ) : null}
                          <Badge tone={ticket.overdue ? 'danger' : statusOf(ticket.status).tone}>
                            {ticket.overdue ? 'Overdue' : statusOf(ticket.status).label}
                          </Badge>
                        </div>
                      </div>
                      <p className="mt-0.5 text-meta text-ink-muted">
                        {ticket.unit} · {capitalise(ticket.category)}
                        {ticket.severity === 'routine' ? ' · Routine' : ''}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-meta text-ink-muted">
                        {['closed', 'cancelled', 'done'].includes(ticket.status) ? null : (
                          <span className={ticket.overdue ? 'font-bold text-danger' : ''}>
                            {ticket.overdue ? 'Overdue since' : 'Due by'} {formatDateTime(ticket.targetBy)}
                          </span>
                        )}
                        {ticket.status === 'done' ? (
                          <span>{landlord ? 'Waiting for the tenant to rate it' : 'Rate the work to close it'}</span>
                        ) : null}
                        {ticket.contractor ? (
                          <span className="inline-flex items-center gap-1.5">
                            <Avatar name={ticket.contractor} size="sm" />
                            {ticket.contractor}
                          </span>
                        ) : null}
                        {ticket.quoteCents ? (
                          <span>
                            Quote <Money cents={ticket.quoteCents} />
                          </span>
                        ) : null}
                        {ticket.rating ? <span>Rated {ticket.rating} of 5</span> : null}
                      </div>
                    </div>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </div>

        <aside className="space-y-4">
          {status === 'active' ? (
            <Card>
              <h2 className="px-5 pb-1 pt-4 text-lead font-bold text-ink">At a glance</h2>
              <dl className="divide-y divide-line-soft">
                <Glance label="Open" value={items.length} />
                <Glance label="Overdue" value={overdue} tone={overdue ? 'danger' : undefined} />
                {landlord ? <Glance label="Quotes to approve" value={toApprove} tone={toApprove ? 'warning' : undefined} /> : null}
                <Glance label={landlord ? 'Waiting for a rating' : 'Waiting for your rating'} value={waitingOnTenant} tone={!landlord && waitingOnTenant ? 'info' : undefined} />
              </dl>
            </Card>
          ) : null}
          <Card>
            <div className="space-y-2 px-5 py-4">
              <h2 className="text-lead font-bold text-ink">How quickly it is seen to</h2>
              <ul className="space-y-1.5 text-meta text-ink-muted">
                <li><b className="font-semibold text-ink">Emergency:</b> unsafe or unlivable, within 24 hours</li>
                <li><b className="font-semibold text-ink">Urgent:</b> broken but livable, within 3 days</li>
                <li><b className="font-semibold text-ink">Routine:</b> wear and tear, within 7 days</li>
              </ul>
            </div>
          </Card>
        </aside>
      </div>

      <Modal
        open={picking}
        onOpenChange={setPicking}
        title={reportLabel}
        description={landlord ? 'Choose the lease the repair is for. It is logged against that unit and the tenant can follow it.' : 'Choose the place the problem is in.'}
      >
        <div className="space-y-3">
          <Select
            aria-label="Lease"
            value={leaseId}
            onChange={(event) => setLeaseId(event.target.value)}
            options={[
              { value: '', label: 'Choose a lease' },
              ...running.map((lease) => ({ value: lease.id, label: lease.tenant ? `${lease.unit} · ${lease.tenant}` : lease.unit })),
            ]}
          />
          <Button block disabled={!leaseId} onClick={() => navigate(`/leases/${leaseId}/tickets/new`)}>
            Continue
          </Button>
        </div>
      </Modal>
    </main>
  );
}

function Glance({ label, value, tone }: { label: string; value: number; tone?: 'danger' | 'warning' | 'info' }) {
  return (
    <div className="flex items-center justify-between gap-3 px-5 py-3">
      <dt className="text-body text-ink">{label}</dt>
      <dd>{tone ? <Badge tone={tone}>{value}</Badge> : <span className="text-body font-bold text-ink">{value}</span>}</dd>
    </div>
  );
}
