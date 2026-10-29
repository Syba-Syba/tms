import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, CardBody, EmptyState, PageHeader, SegmentedControl, Spinner } from '@hlonie/toolbox/ui';
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

const severityTone = { emergency: 'danger', urgent: 'warning', routine: 'neutral' } as const;

export function TicketsList() {
  const [status, setStatus] = useState<'active' | 'closed'>('active');
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['tickets', status],
    queryFn: () => api.get<{ items: Ticket[] }>('/tickets', { query: { status } }),
  });

  const items = data?.items ?? [];

  return (
    <main className={PAGE.reading}>
      <PageHeader
        title="Maintenance"
        description={
          isLandlord()
            ? 'Everything reported across your units.'
            : 'Problems you have reported, and where they stand.'
        }
      />

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
              ? 'When something breaks, report it and it appears here.'
              : 'Closed tickets keep their history and rating.'
          }
        />
      ) : null}

      <div className="space-y-3">
        {items.map((ticket) => (
          <Card key={ticket.id}>
            <CardBody className="space-y-2">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-lead font-semibold">{ticket.title}</p>
                  <p className="text-xs text-ink-muted">
                    {ticket.unit} · {capitalise(ticket.category)}
                    {ticket.contractor ? ` · ${ticket.contractor}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={severityTone[ticket.severity]}>{capitalise(ticket.severity)}</Badge>
                  <Badge tone={ticket.overdue ? 'danger' : statusOf(ticket.status).tone}>
                    {ticket.overdue ? 'Overdue' : statusOf(ticket.status).label}
                  </Badge>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
                <span className={ticket.overdue ? 'font-bold text-danger' : ''}>
                  {ticket.overdue ? 'Overdue since' : 'Due by'} {formatDateTime(ticket.targetBy)}
                </span>
                {ticket.quoteCents ? (
                  <span>
                    Quote <Money cents={ticket.quoteCents} />
                  </span>
                ) : null}
                {ticket.rating ? <span>Rated {ticket.rating} of 5</span> : null}
              </div>
            </CardBody>
          </Card>
        ))}
      </div>
    </main>
  );
}
