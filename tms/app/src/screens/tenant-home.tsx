import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, useToast } from '@hlonie/toolbox/ui';
import { api, humanError } from '../api/client';
import { Money } from '../components/money';
import { ChevronRightIcon } from '@hlonie/toolbox/icons';
import { daysUntil, formatDate, formatInstant } from '../lib/format';
import { QueryState } from '../components/query-state';
import { ConfirmNotice, needsTenantConfirmation, type NoticeToConfirm } from '../components/confirm-notice';
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
  // Ended tenancies too: once the deposit is settled the lease is terminated, and the tenant
  // still needs their deposit statement and documents.
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['leases', 'with-ended'],
    queryFn: () => api.get<{ items: LeaseRow[] }>('/leases', { query: { include: 'ended' } }),
  });

  // The list row says only that notice is served. Whether the tenant must still confirm it, and
  // what it says, comes with the lease itself, so it is fetched once there is a notice.
  const noticeLease = data?.items.find((item) => item.status === 'active' && item.terminationEffectiveOn);
  const { data: noticeDetail } = useQuery({
    queryKey: ['lease', noticeLease?.id],
    queryFn: () =>
      api.get<{ id: string; viewer: { isLandlord: boolean; isTenant: boolean }; termination: NoticeToConfirm | null }>(
        `/leases/${noticeLease!.id}`,
      ),
    enabled: Boolean(noticeLease),
  });

  if (!data) {
    return <QueryState isLoading={isLoading} isError={isError} error={error} onRetry={refetch} what="Your home" />;
  }

  // The list is newest first, so an accepted renewal that has not started yet would otherwise
  // take over the home screen, with a zero deposit and none of the current lease's invoices.
  const live = data.items.filter((item) => item.status !== 'terminated');
  const lease = live.find((item) => item.status === 'active') ?? live[0];
  const upcoming = live.find((item) => item.status === 'scheduled' && item.id !== lease?.id);
  if (!lease) return <NoLeaseYet ended={data.items.find((item) => item.status === 'terminated')} />;

  // Generated but not yet signed: the one thing to do is sign. Showing "You owe nothing" and a
  // R0 deposit here read as if they had moved in, and the lease to sign was three taps away.
  if (lease.status === 'out_for_signature') {
    return (
      <main className={PAGE.narrow}>
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
          {noticeDetail && noticeDetail.id === lease.id && needsTenantConfirmation(noticeDetail.viewer, noticeDetail.termination) ? (
            <div className="mt-3 space-y-2">
              <p>Your landlord recorded this notice for you and needs you to confirm it.</p>
              <ConfirmNotice leaseId={lease.id} termination={noticeDetail.termination} />
            </div>
          ) : null}
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

/** Who may still withdraw: the applicant, until a lease has gone out for signing. */
export const applicantCanWithdraw = (item: Pick<MyApplication, 'status' | 'leaseId' | 'leaseStatus'>) =>
  ['submitted', 'screening', 'approved'].includes(item.status) && (!item.leaseId || item.leaseStatus === 'draft');

/** A tenancy that has ended: where its deposit statement and documents are. */
function EndedLease({ lease }: { lease: LeaseRow }) {
  return (
    <Card className="mb-4">
      <div className="space-y-2 p-4">
        <p className="text-lead font-semibold text-ink">Your lease of {lease.unit} has ended</p>
        <p className="text-body text-ink-muted">
          {lease.ref} ran to {formatDate(lease.endDate)}. Your deposit statement, inspections and invoices are kept.
        </p>
        <Link className="inline-block text-body font-semibold text-brand-600" to="/documents">
          Deposit statement and documents
        </Link>
      </div>
    </Card>
  );
}

/** Before there is a lease: what they applied for and where it stands, rather than an empty page. */
function NoLeaseYet({ ended }: { ended?: LeaseRow }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [withdrawing, setWithdrawing] = useState<MyApplication | null>(null);
  const [busy, setBusy] = useState(false);
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['my-applications'],
    queryFn: () => api.get<{ items: MyApplication[] }>('/me/applications'),
  });
  // Changing their mind used to leave the unit held until the landlord declined.
  const withdraw = async (item: MyApplication) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.post(`/applications/${item.id}/withdraw`, {});
      setWithdrawing(null);
      toast.show({ title: 'Application withdrawn', tone: 'info' });
      queryClient.invalidateQueries({ queryKey: ['my-applications'] });
      queryClient.invalidateQueries({ queryKey: ['applications'] });
    } catch (error) {
      toast.show({ title: 'Not withdrawn', description: humanError(error), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  // "No lease yet" is only true once the list has answered; a failure used to read as it.
  if (!data) {
    return <QueryState isLoading={isLoading} isError={isError} error={error} onRetry={refetch} what="Your applications" />;
  }
  const items = data.items;
  if (items.length === 0) {
    if (ended) {
      return (
        <main className={PAGE.narrow}>
          <EndedLease lease={ended} />
        </main>
      );
    }
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
      {ended ? <EndedLease lease={ended} /> : null}
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
                  {applicantCanWithdraw(item) ? (
                    <div>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setWithdrawing(item)}>
                        Withdraw application
                      </Button>
                    </div>
                  ) : null}
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
      <ConfirmDialog
        open={Boolean(withdrawing)}
        onOpenChange={(next) => !next && !busy && setWithdrawing(null)}
        title="Withdraw this application?"
        description={withdrawing ? `The landlord is no longer asked to decide, and ${withdrawing.unit} is no longer held for you.` : ''}
        confirmLabel="Withdraw the application"
        loading={busy}
        onConfirm={() => withdrawing && withdraw(withdrawing)}
      />
    </main>
  );
}
