import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Alert, Badge, Card, CardBody, EmptyState, PageHeader, Spinner } from '@hlonie/toolbox/ui';
import { api } from '../api/client';
import { Ledger } from '../components/money';
import { isLandlord } from '../lib/session';
import { TenantHome } from './tenant-home';

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

const daysUntil = (date: string) =>
  Math.round((new Date(date).getTime() - Date.now()) / 86400000);

export function Home() {
  // A tenant has one home, not a portfolio, so they get a different screen entirely.
  if (!isLandlord()) return <TenantHome />;
  return <LandlordHome />;
}

function LandlordHome() {
  const { data, isLoading } = useQuery({
    queryKey: ['leases'],
    queryFn: () => api.get<{ role: string; items: LeaseRow[] }>('/leases'),
  });

  if (isLoading) {
    return (
      <main className="mx-auto flex max-w-5xl justify-center px-5 py-16">
        <Spinner />
      </main>
    );
  }

  const leases = data?.items ?? [];
  const landlord = data?.role === 'landlord';

  return (
    <main className="mx-auto max-w-5xl px-5 py-6">
      <PageHeader
        title={landlord ? 'Your units' : 'Your home'}
        description={
          landlord
            ? `${leases.length} lease${leases.length === 1 ? '' : 's'} running.`
            : 'Everything about your tenancy in one place.'
        }
      />

      {leases.length === 0 ? (
        <EmptyState
          title="Nothing here yet"
          description={
            landlord
              ? 'Once a lease is signed it appears here.'
              : 'When your landlord issues a lease it will show up here.'
          }
        />
      ) : null}

      <div className="space-y-4">
        {leases.map((lease) => {
          const endingIn = daysUntil(lease.endDate);
          return (
            <Card key={lease.id}>
              <CardBody className="space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-[17px] font-bold tracking-tight">{lease.unit}</p>
                    <p className="text-xs text-ink-muted">
                      {lease.ref} · {landlord ? lease.tenant : `until ${lease.endDate}`}
                    </p>
                  </div>
                  <Badge tone={lease.status === 'active' ? 'success' : 'neutral'}>
                    {lease.status}
                  </Badge>
                </div>

                <div className="grid grid-cols-2 gap-4 border-y border-line-soft py-3 sm:grid-cols-4">
                  <div>
                    <p className="text-[10.5px] font-bold uppercase tracking-widest text-ink-muted">
                      Rent
                    </p>
                    <Ledger cents={lease.monthlyRentCents} className="text-[19px]" />
                  </div>
                  <div>
                    <p className="text-[10.5px] font-bold uppercase tracking-widest text-ink-muted">
                      Outstanding
                    </p>
                    <Ledger
                      cents={lease.outstandingCents}
                      className={`text-[19px] ${lease.outstandingCents > 0 ? 'text-danger' : ''}`}
                    />
                  </div>
                  <div>
                    <p className="text-[10.5px] font-bold uppercase tracking-widest text-ink-muted">
                      Deposit held
                    </p>
                    <Ledger cents={lease.depositBalanceCents} className="text-[19px]" />
                  </div>
                  <div>
                    <p className="text-[10.5px] font-bold uppercase tracking-widest text-ink-muted">
                      Open tickets
                    </p>
                    <p className="text-[19px] font-extrabold tracking-tight">{lease.openTickets}</p>
                  </div>
                </div>

                {lease.terminationEffectiveOn ? (
                  <Alert tone="warning" title={`Ending ${lease.terminationEffectiveOn}`}>
                    Notice has been served. The exit inspection must happen in the final three
                    days of the lease, with both of you there.
                  </Alert>
                ) : lease.renewalOffered ? (
                  <Alert tone="info" title="Renewal offered">
                    {landlord ? 'Waiting on the tenant to answer.' : 'You have an offer to review.'}
                  </Alert>
                ) : endingIn <= 60 ? (
                  <Alert tone="info" title={`Lease ends in ${endingIn} days`}>
                    {landlord
                      ? 'Decide on a renewal, or book the exit inspection.'
                      : 'Your landlord should be in touch about renewing.'}
                  </Alert>
                ) : null}

                <div className="flex flex-wrap gap-2">
                  <Link
                    to={`/leases/${lease.id}/rent`}
                    className="rounded-sm bg-brand-50 px-3 py-2 text-[13px] font-bold text-brand-500"
                  >
                    Rent and deposit
                  </Link>
                  <Link
                    to={`/leases/${lease.id}/tickets/new`}
                    className="rounded-sm bg-surface-muted px-3 py-2 text-[13px] font-bold text-ink"
                  >
                    Report a problem
                  </Link>
                </div>
              </CardBody>
            </Card>
          );
        })}
      </div>
    </main>
  );
}
