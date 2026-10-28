import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { Alert, Button, Card, EmptyState } from '@hlonie/toolbox/ui';
import { api } from '../api/client';
import { Ledger } from '../components/money';
import { ChevronRightIcon } from '@hlonie/toolbox/icons';
import { daysUntil, formatDate } from '../lib/format';
import { currentUser } from '../lib/session';
import { QueryState } from '../components/query-state';

interface LeaseRow {
  id: string; ref: string; status: string; unit: string; startDate: string; endDate: string;
  monthlyRentCents: number; depositBalanceCents: number; outstandingCents: number;
  openTickets: number; terminationEffectiveOn: string | null; renewalOffered: boolean;
}


/**
 * A tenant has one home, not a portfolio. So this leads with the two things they actually
 * want to know, whether they owe anything and what the deposit is worth, and puts the
 * paperwork behind them.
 */
export function TenantHome() {
  const navigate = useNavigate();
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['leases'],
    queryFn: () => api.get<{ items: LeaseRow[] }>('/leases'),
  });

  if (!data) {
    return <QueryState isLoading={isLoading} isError={isError} error={error} onRetry={refetch} what="Your home" />;
  }

  // The list is newest first, so an accepted renewal that has not started yet would otherwise
  // take over the home screen, with a zero deposit and none of the current lease's invoices.
  const lease = data.items.find((item) => item.status === 'active') ?? data.items[0];
  const upcoming = data.items.find((item) => item.status === 'scheduled' && item.id !== lease?.id);
  if (!lease) {
    return (
      <main className="mx-auto max-w-2xl px-5 py-6">
        <EmptyState
          title="No active lease"
          description="When your landlord issues a lease it appears here, along with everything attached to it."
        />
      </main>
    );
  }

  const settled = lease.outstandingCents === 0;
  const endingIn = daysUntil(lease.endDate);

  const firstName = currentUser()?.name.split(' ')[0];
  const actions = [
    { label: 'Rent and deposit', hint: 'Statement, EFT reference, send proof of payment', to: `/leases/${lease.id}/rent` },
    {
      label: 'Maintenance',
      hint: lease.openTickets ? `${lease.openTickets} open request${lease.openTickets === 1 ? '' : 's'}` : 'Everything you have reported',
      to: '/tickets',
    },
    { label: 'Your lease', hint: `${lease.ref}, runs to ${formatDate(lease.endDate)}`, to: `/leases/${lease.id}` },
    { label: 'Documents', hint: 'Lease, inspections and invoices', to: '/documents' },
  ];

  return (
    <main className="mx-auto max-w-2xl px-4 py-6 sm:px-5">
      <p className="text-[15px] text-ink-muted">{firstName ? `Hi ${firstName}` : 'Hi'}</p>
      <h1 className="mb-5 font-display text-[30px] font-medium leading-tight tracking-[-0.01em] text-ink">{lease.unit}</h1>

      {/* The one warm panel in the app: the tenant's own money, said plainly. */}
      <section
        className={`mb-4 rounded-md px-5 py-6 ${
          settled ? 'bg-brand-50' : 'bg-[color-mix(in_srgb,var(--tb-danger)_7%,var(--tb-surface))]'
        }`}
      >
        <p className="text-[14px] text-ink-muted">{settled ? 'You owe nothing' : 'You owe'}</p>
        <Ledger cents={lease.outstandingCents} className={`block text-[44px] leading-tight ${settled ? '' : 'text-danger'}`} />
        {settled ? (
          <p className="mt-1 text-[14px] text-brand-600">Fully paid up. Thank you.</p>
        ) : (
          <p className="mt-1 text-[14px] text-ink">
            Pay by EFT with the reference <b className="font-mono font-medium">{lease.ref}</b> exactly, so the bank
            can match it to your unit.
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-x-8 gap-y-3 border-t border-black/10 pt-4">
          <div>
            <p className="text-[13px] text-ink-muted">Rent a month</p>
            <Ledger cents={lease.monthlyRentCents} className="text-[20px]" />
          </div>
          <div>
            <p className="text-[13px] text-ink-muted">Your deposit, with interest</p>
            <Ledger cents={lease.depositBalanceCents} className="text-[20px]" />
          </div>
        </div>
      </section>

      {upcoming ? (
        <Alert tone="info" title={`Your renewal ${upcoming.ref} starts ${formatDate(upcoming.startDate)}`} className="mb-4">
          It only starts once you and your landlord have both signed it.{' '}
          <button type="button" className="font-bold text-brand-500" onClick={() => navigate(`/lease/${upcoming.id}`)}>
            Open the new lease
          </button>
        </Alert>
      ) : null}

      {lease.renewalOffered ? (
        <Alert tone="info" title="You have a renewal offer" className="mb-4">
          Open your lease to see the new rent and dates, then accept or decline.
        </Alert>
      ) : lease.terminationEffectiveOn ? (
        <Alert tone="warning" title={`Your lease ends ${formatDate(lease.terminationEffectiveOn)}`} className="mb-4">
          The exit inspection must happen in the final three days, with you there. If it does not
          happen, the law treats the place as undamaged and nothing can be deducted from your
          deposit.
        </Alert>
      ) : endingIn <= 60 ? (
        <Alert tone="info" title={`Your lease ends in ${endingIn} days`} className="mb-4">
          Your landlord should be in touch about renewing.
        </Alert>
      ) : null}

      <Button block size="lg" className="mb-4" onClick={() => navigate(`/leases/${lease.id}/tickets/new`)}>
        Report a problem
      </Button>

      <Card>
        <ul className="divide-y divide-line-soft">
          {actions.map((action) => (
            <li key={action.label}>
              <Link to={action.to} className="flex items-center gap-3 px-4 py-3.5 hover:bg-neutral-50">
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-medium text-ink">{action.label}</span>
                  <span className="block truncate text-[13px] text-ink-muted">{action.hint}</span>
                </span>
                <ChevronRightIcon className="shrink-0 text-ink-muted" />
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </main>
  );
}
