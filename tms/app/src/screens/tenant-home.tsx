import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Alert, Button, Card, CardBody, EmptyState, PageHeader, Spinner } from '@hlonie/toolbox/ui';
import { api } from '../api/client';
import { Ledger } from '../components/money';

interface LeaseRow {
  id: string; ref: string; unit: string; endDate: string;
  monthlyRentCents: number; depositBalanceCents: number; outstandingCents: number;
  openTickets: number; terminationEffectiveOn: string | null; renewalOffered: boolean;
}

const daysUntil = (date: string) => Math.round((new Date(date).getTime() - Date.now()) / 86400000);

/**
 * A tenant has one home, not a portfolio. So this leads with the two things they actually
 * want to know, whether they owe anything and what the deposit is worth, and puts the
 * paperwork behind them.
 */
export function TenantHome() {
  const { data, isLoading } = useQuery({
    queryKey: ['leases'],
    queryFn: () => api.get<{ items: LeaseRow[] }>('/leases'),
  });

  if (isLoading) return <main className="p-16 text-center"><Spinner /></main>;

  const lease = data?.items[0];
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

  return (
    <main className="mx-auto max-w-2xl px-5 py-6">
      <PageHeader title={lease.unit} description={`${lease.ref} · your lease runs to ${lease.endDate}`} />

      <Card className="mb-4">
        <CardBody className="space-y-1 py-7 text-center">
          <p className="text-[10.5px] font-bold uppercase tracking-widest text-ink-muted">
            {settled ? 'Balance' : 'Outstanding'}
          </p>
          <Ledger
            cents={lease.outstandingCents}
            className={`block text-[44px] ${settled ? '' : 'text-danger'}`}
          />
          {settled ? (
            <p className="text-[13px] font-bold text-success">Fully paid up</p>
          ) : (
            <p className="text-[13px] text-ink-muted">
              Pay by EFT using the reference <b className="font-mono text-ink">{lease.ref}</b> exactly,
              or the bank cannot match it to your unit.
            </p>
          )}
        </CardBody>
      </Card>

      <div className="mb-4 grid grid-cols-2 gap-3">
        <Card>
          <CardBody>
            <p className="text-[10.5px] font-bold uppercase tracking-widest text-ink-muted">Rent</p>
            <Ledger cents={lease.monthlyRentCents} className="text-[21px]" />
            <p className="mt-1 text-xs text-ink-muted">a month</p>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <p className="text-[10.5px] font-bold uppercase tracking-widest text-ink-muted">
              Your deposit
            </p>
            <Ledger cents={lease.depositBalanceCents} className="text-[21px]" />
            <p className="mt-1 text-xs text-ink-muted">interest included, and it keeps growing</p>
          </CardBody>
        </Card>
      </div>

      {lease.renewalOffered ? (
        <Alert tone="info" title="You have a renewal offer" className="mb-4">
          Open your lease to see the new rent and dates, then accept or decline.
        </Alert>
      ) : lease.terminationEffectiveOn ? (
        <Alert tone="warning" title={`Your lease ends ${lease.terminationEffectiveOn}`} className="mb-4">
          The exit inspection must happen in the final three days, with you there. If it does not
          happen, the law treats the place as undamaged and nothing can be deducted from your
          deposit.
        </Alert>
      ) : endingIn <= 60 ? (
        <Alert tone="info" title={`Your lease ends in ${endingIn} days`} className="mb-4">
          Your landlord should be in touch about renewing.
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Link to={`/leases/${lease.id}/tickets/new`}>
          <Button block>Report a problem</Button>
        </Link>
        <Link to={`/leases/${lease.id}/rent`}>
          <Button block variant="outline">Rent and deposit</Button>
        </Link>
        <Link to={`/leases/${lease.id}`}>
          <Button block variant="outline">Your lease</Button>
        </Link>
        <Link to="/tickets">
          <Button block variant="outline">
            Maintenance{lease.openTickets ? ` (${lease.openTickets} open)` : ''}
          </Button>
        </Link>
      </div>
    </main>
  );
}
