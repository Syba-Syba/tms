import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { Alert, Badge, Button, Card, EmptyState } from '@hlonie/toolbox/ui';
import { api } from '../api/client';
import { Money } from '../components/money';
import { ChevronRightIcon } from '@hlonie/toolbox/icons';
import { daysUntil, formatDate, formatInstant } from '../lib/format';
import { currentUser } from '../lib/session';
import { QueryState } from '../components/query-state';
import { PAGE } from '../lib/layout';

interface LeaseRow {
  id: string; ref: string; status: string; unit: string; startDate: string; endDate: string;
  monthlyRentCents: number; depositBalanceCents: number; depositOwingCents: number; outstandingCents: number;
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
  if (!lease) return <NoLeaseYet />;

  // Generated but not yet signed: the one thing to do is sign. Showing "You owe nothing" and a
  // R0 deposit here read as if they had moved in, and the lease to sign was three taps away.
  if (lease.status === 'out_for_signature') {
    return (
      <main className={PAGE.narrow}>
        <p className="text-lead text-ink-muted">{currentUser()?.name.split(' ')[0] ? `Hi ${currentUser()!.name.split(' ')[0]}` : 'Hi'}</p>
        <h1 className="mb-5 font-display text-display font-medium leading-tight tracking-[-0.01em] text-ink">{lease.unit}</h1>
        <Card>
          <div className="space-y-3 p-5">
            <h2 className="text-title font-semibold text-ink">Your lease is ready to sign</h2>
            <p className="text-body text-ink-muted">
              {lease.ref}, from {formatDate(lease.startDate)} to {formatDate(lease.endDate)}. Read it, then sign
              on your phone. It starts once you and your landlord have both signed.
            </p>
            <Button block size="lg" onClick={() => navigate(`/lease/${lease.id}`)}>Read and sign the lease</Button>
          </div>
        </Card>
      </main>
    );
  }

  // Rent and charges invoiced, plus a deposit not yet received: both are what they owe.
  const owing = lease.outstandingCents + (lease.depositOwingCents ?? 0);
  const settled = owing === 0;
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
    <main className={PAGE.wide}>
      <p className="text-lead text-ink-muted">{firstName ? `Hi ${firstName}` : 'Hi'}</p>
      <h1 className="mb-5 font-display text-display font-medium leading-tight tracking-[-0.01em] text-ink">{lease.unit}</h1>

      {/* On a laptop: their money and any notices on the left, what they can do on the right. */}
      <div className="grid grid-cols-1 items-start gap-x-6 lg:grid-cols-2">
      <div>
      {/* The one warm panel in the app: the tenant's own money, said plainly. */}
      <section
        className={`mb-4 rounded-md px-5 py-6 ${
          settled ? 'bg-brand-50' : 'bg-[color-mix(in_srgb,var(--tb-danger)_7%,var(--tb-surface))]'
        }`}
      >
        <p className="text-body text-ink-muted">{settled ? 'You owe nothing' : 'You owe'}</p>
        <Money cents={owing} className={`block text-hero leading-tight ${settled ? '' : 'text-danger'}`} />
        {lease.depositOwingCents > 0 ? (
          <p className="text-body text-ink">
            Including your deposit of <Money cents={lease.depositOwingCents} />, due within 7 days of signing.
          </p>
        ) : null}
        {settled ? (
          <p className="mt-1 text-body text-brand-600">Fully paid up. Thank you.</p>
        ) : (
          <p className="mt-1 text-body text-ink">
            Pay by EFT with the reference <b className="font-mono font-medium">{lease.ref}</b> exactly, so the bank
            can match it to your unit.
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-x-8 gap-y-3 border-t border-line pt-4">
          <div>
            <p className="text-meta text-ink-muted">Rent a month</p>
            <Money cents={lease.monthlyRentCents} className="text-title" />
          </div>
          <div>
            <p className="text-meta text-ink-muted">Your deposit, with interest</p>
            <Money cents={lease.depositBalanceCents} className="text-title" />
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
      ) : endingIn >= 0 && endingIn <= 60 ? (
        <Alert tone="info" title={`Your lease ends in ${endingIn} days`} className="mb-4">
          Your landlord should be in touch about renewing.
        </Alert>
      ) : endingIn < 0 && lease.status === 'active' ? (
        // A negative count used to read "ends in -40 days". A fixed-term lease that runs past
        // its end date with nobody giving notice carries on month to month (CPA s14).
        <Alert tone="info" title="Your lease has passed its end date and continues month to month." className="mb-4" />
      ) : null}

      </div>
      <div>
      <Button block size="lg" className="mb-4" onClick={() => navigate(`/leases/${lease.id}/tickets/new`)}>
        Report a problem
      </Button>

      <Card>
        <ul className="divide-y divide-line-soft">
          {actions.map((action) => (
            <li key={action.label}>
              <Link to={action.to} className="flex items-center gap-3 px-4 py-3.5 hover:bg-surface-muted">
                <span className="min-w-0 flex-1">
                  <span className="block text-lead font-medium text-ink">{action.label}</span>
                  <span className="block truncate text-meta text-ink-muted">{action.hint}</span>
                </span>
                <ChevronRightIcon className="shrink-0 text-ink-muted" />
              </Link>
            </li>
          ))}
        </ul>
      </Card>
      </div>
      </div>
    </main>
  );
}

interface MyApplication {
  id: string; status: string; submittedAt: string | null; unit: string; landlord: string;
  documents: number; leaseId: string | null; leaseStatus: string | null;
}

const APPLICATION_STATUS: Record<string, { label: string; tone: 'info' | 'success' | 'danger' | 'neutral'; next: string }> = {
  draft: { label: 'Not sent', tone: 'neutral', next: 'Finish the form and upload your documents to send it.' },
  submitted: { label: 'Waiting for the landlord', tone: 'info', next: 'The unit is held for you while the landlord decides. You get an email either way.' },
  screening: { label: 'Being checked', tone: 'info', next: 'The landlord is checking your details. You get an email either way.' },
  approved: { label: 'Approved', tone: 'success', next: 'Your landlord is preparing the lease. It appears here to sign.' },
  declined: { label: 'Declined', tone: 'danger', next: 'The landlord chose not to go ahead. Your documents are deleted after twelve months.' },
  withdrawn: { label: 'Withdrawn', tone: 'neutral', next: 'This application is closed.' },
};

/**
 * Where an application stands, read together with its lease. An approved application stays
 * approved after the lease it led to has ended, so a former tenant used to be told their
 * landlord was still preparing the lease.
 */
export function applicationStatus(item: Pick<MyApplication, 'id' | 'status' | 'leaseId' | 'leaseStatus'>): {
  label: string;
  tone: 'info' | 'success' | 'danger' | 'neutral';
  next: string;
  link: { to: string; label: string } | null;
} {
  if (item.status === 'approved' && item.leaseId && item.leaseStatus) {
    if (item.leaseStatus === 'terminated' || item.leaseStatus === 'cancelled') {
      return { label: 'Lease ended', tone: 'neutral', next: 'The lease that followed this application has ended.', link: null };
    }
    if (item.leaseStatus === 'out_for_signature') {
      return {
        label: 'Lease ready to sign',
        tone: 'info',
        next: 'Your landlord has issued the lease. Read it, then sign on your phone.',
        link: { to: `/lease/${item.leaseId}`, label: 'Read and sign the lease' },
      };
    }
    if (item.leaseStatus === 'active' || item.leaseStatus === 'scheduled') {
      return {
        label: 'Lease signed',
        tone: 'success',
        next: 'Both of you have signed the lease.',
        link: { to: `/lease/${item.leaseId}`, label: 'Open the lease' },
      };
    }
  }
  const known = APPLICATION_STATUS[item.status] ?? { label: item.status, tone: 'neutral' as const, next: '' };
  return { ...known, link: null };
}

/** Before there is a lease: what they applied for and where it stands, rather than an empty page. */
function NoLeaseYet() {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['my-applications'],
    queryFn: () => api.get<{ items: MyApplication[] }>('/me/applications'),
  });
  // "No lease yet" is only true once the list has answered; a failure used to read as it.
  if (!data) {
    return <QueryState isLoading={isLoading} isError={isError} error={error} onRetry={refetch} what="Your applications" />;
  }
  const items = data.items;
  if (items.length === 0) {
    return (
      <main className={PAGE.narrow}>
        <EmptyState
          title="No lease yet"
          description="When you apply for a place, or your landlord issues a lease, it appears here. To apply, open the link your landlord shared."
        />
      </main>
    );
  }
  return (
    <main className={PAGE.narrow}>
      <h1 className="mb-5 font-display text-display font-medium leading-tight tracking-[-0.01em] text-ink">Your applications</h1>
      <ul className="space-y-3">
        {items.map((item) => {
          const status = applicationStatus(item);
          return (
            <li key={item.id}>
              <Card>
                <div className="space-y-2 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-lead font-semibold text-ink">{item.unit}</p>
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </div>
                  <p className="text-meta text-ink-muted">
                    {item.landlord}{item.submittedAt ? `, sent ${formatInstant(item.submittedAt)}` : ''}
                  </p>
                  <p className="text-body text-ink">{status.next}</p>
                  {item.status === 'draft' || (item.status === 'submitted' && item.documents < 4) ? (
                    <Link className="inline-block text-body font-semibold text-brand-600" to={`/apply/${item.id}/documents`}>
                      Upload documents
                    </Link>
                  ) : null}
                  {status.link ? (
                    <Link className="inline-block text-body font-semibold text-brand-600" to={status.link.to}>
                      {status.link.label}
                    </Link>
                  ) : null}
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
    </main>
  );
}
