import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, useToast } from '@hlonie/toolbox/ui';
import { api, humanError } from '../api/client';
import { Money } from '../components/money';
import { ChevronRightIcon } from '@hlonie/toolbox/icons';
import { daysUntil, formatDate, formatInstant, headlineZar } from '../lib/format';
import { localToday } from '../lib/dates';
import { currentUser } from '../lib/session';
import { LinkButton } from '../components/link-button';
import { useOpenDocument } from '../lib/open-document';
import { FileIcon, HomeIcon, WalletIcon, WrenchIcon } from '../components/nav-icons';
import { QueryState } from '../components/query-state';
import { ConfirmNotice, needsTenantConfirmation, type NoticeToConfirm } from '../components/confirm-notice';
import { PAGE } from '../lib/layout';

interface LeaseRow {
  id: string; ref: string; status: string; unit: string; startDate: string; endDate: string;
  monthlyRentCents: number; depositBalanceCents: number; depositOwingCents: number; outstandingCents: number;
  openTickets: number; terminationEffectiveOn: string | null; renewalOffered: boolean;
  /** A notice the landlord recorded for the tenant that the tenant has not confirmed yet. */
  awaitingTenant?: boolean;
}


/** The notice as the home screen needs it: what ConfirmNotice reads, plus the landlord's attestation. */
interface HomeNotice extends NoticeToConfirm {
  /** The landlord attached the tenant's written notice and vouched for it, so it stands unconfirmed. */
  attested?: boolean;
  attestation?: { at: string; statement: string | null; evidenceKey: string | null } | null;
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
  const noticeLease = data?.items.find((item) => item.status === 'active' && (item.terminationEffectiveOn || item.awaitingTenant));
  const { data: noticeDetail } = useQuery({
    queryKey: ['lease', noticeLease?.id],
    queryFn: () =>
      api.get<{ id: string; viewer: { isLandlord: boolean; isTenant: boolean }; termination: HomeNotice | null }>(
        `/leases/${noticeLease!.id}`,
      ),
    enabled: Boolean(noticeLease),
  });

  // When rent is due, for the headline. Shared with the rent screen's cache.
  const current = data?.items.find((item) => item.status === 'active');
  const { data: statement } = useQuery({
    queryKey: ['statement', current?.id],
    queryFn: () => api.get<{ invoices: { id: string; dueOn: string; status: string }[] }>(`/leases/${current!.id}/statement`),
    enabled: Boolean(current),
    retry: false,
  });
  const queryClient = useQueryClient();
  const toast = useToast();
  const openDocument = useOpenDocument();
  const [disputing, setDisputing] = useState(false);
  const [busy, setBusy] = useState(false);

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
      <main className={PAGE.wide}>
        <Greeting unit={lease.unit} />
        <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <section className="rounded-md bg-tint-info px-6 py-7 sm:px-8">
            <p className="text-body font-semibold text-[var(--tb-info-ink)]">One thing to do</p>
            <h2 className="mt-1 font-display text-hero font-bold leading-[1.1] tracking-[-0.02em] text-ink">Your lease is ready to sign</h2>
            <p className="mt-3 max-w-prose text-lead text-ink">
              {lease.ref}, from {formatDate(lease.startDate)} to {formatDate(lease.endDate)}. Read it, then sign
              on your phone. It starts once you and your landlord have both signed.
            </p>
            <Button size="lg" className="mt-5 w-full sm:w-auto" onClick={() => navigate(`/lease/${lease.id}`)}>Read and sign the lease</Button>
          </section>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-1">
            <Tile label="Rent a month"><Money cents={lease.monthlyRentCents} whole className="text-figure text-ink" /></Tile>
            <Tile label="Lease runs" hint={`to ${formatDate(lease.endDate)}`}>
              <span className="text-title font-bold text-ink">{formatDate(lease.startDate)}</span>
            </Tile>
          </div>
        </div>
      </main>
    );
  }

  // Rent and charges invoiced, plus a deposit not yet received: both are what they owe.
  const owing = lease.outstandingCents + (lease.depositOwingCents ?? 0);
  const settled = owing === 0;
  const endingIn = daysUntil(lease.endDate);

  // The statement says when the money is due, which decides between "due on" and "overdue".
  // Without it (still loading, or it failed) the amount alone is shown.
  const unpaid = (statement?.invoices ?? [])
    .filter((invoice) => invoice.status === 'issued' || invoice.status === 'part_paid')
    .sort((a, b) => a.dueOn.localeCompare(b.dueOn));
  const today = localToday();
  const overdue = unpaid.some((invoice) => invoice.dueOn < today);
  const nextDue = unpaid.find((invoice) => invoice.dueOn >= today)?.dueOn ?? null;
  const standing: 'paid' | 'due' | 'overdue' = settled
    ? 'paid'
    : overdue || (lease.outstandingCents > 0 && !nextDue && statement !== undefined)
      ? 'overdue'
      : 'due';
  const HERO = {
    paid: { tile: 'bg-tint-success', label: 'text-[var(--tb-success-ink)]', eyebrow: 'Rent' },
    due: { tile: 'bg-tint-warning', label: 'text-[var(--tb-warning-ink)]', eyebrow: 'Coming up' },
    overdue: { tile: 'bg-tint-danger', label: 'text-[var(--tb-danger-ink)]', eyebrow: 'Overdue' },
  }[standing];
  const amount = headlineZar(owing);
  const headline =
    standing === 'paid'
      ? 'You are paid up'
      : standing === 'overdue'
        ? `${amount} is overdue`
        : lease.outstandingCents === 0
          ? `Your deposit of ${amount} is due`
          : nextDue
            ? `${amount} is due on ${formatDate(nextDue)}`
            : `You owe ${amount}`;

  const notice = noticeDetail && noticeDetail.id === lease.id ? noticeDetail.termination : null;
  const noticeLive = notice && notice.status !== 'withdrawn' && notice.status !== 'settled' ? notice : null;
  const awaitingConfirmation =
    noticeDetail && noticeLive && needsTenantConfirmation(noticeDetail.viewer, noticeLive) ? noticeLive : null;
  // The landlord attached the tenant's own written notice: it stands without a confirmation,
  // and the tenant is shown the file it rests on.
  const attestedNotice = noticeDetail?.viewer.isTenant && noticeLive?.attested ? noticeLive : null;
  // The server refuses a confirmation once the last day has passed, and a dispute is for before it.
  const disputable = noticeLive ? today <= noticeLive.effectiveOn : false;
  const pastEnd = awaitingConfirmation ? today > awaitingConfirmation.effectiveOn : false;

  const withdrawNotice = async () => {
    if (busy || !noticeLive) return;
    setBusy(true);
    try {
      await api.post(`/terminations/${noticeLive.id}/withdraw`, {});
      setDisputing(false);
      toast.show({ title: 'Notice withdrawn', description: 'Your lease carries on. Your landlord is told.', tone: 'success' });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['lease', lease.id] }),
        queryClient.invalidateQueries({ queryKey: ['leases'] }),
      ]);
    } catch (error) {
      toast.show({ title: 'That did not work', description: humanError(error), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const actions = [
    { label: 'Rent and deposit', hint: 'Statement, banking details, proof of payment', to: `/leases/${lease.id}/rent`, icon: WalletIcon },
    {
      label: 'Repairs',
      hint: lease.openTickets ? `${lease.openTickets} open request${lease.openTickets === 1 ? '' : 's'}` : 'Everything you have reported',
      to: '/tickets',
      icon: WrenchIcon,
      count: lease.openTickets,
    },
    { label: 'Your lease', hint: `${lease.ref}, runs to ${formatDate(lease.endDate)}`, to: `/leases/${lease.id}`, icon: HomeIcon },
    { label: 'Documents', hint: 'Lease, inspections and invoices', to: '/documents', icon: FileIcon },
  ];

  return (
    <main className={PAGE.wide}>
      <Greeting unit={lease.unit} />

      {/* A notice the landlord recorded for them comes before everything: until they answer it,
          the deposit cannot be settled, and if it is wrong they need the way out just as close. */}
      {awaitingConfirmation && pastEnd ? (
        <section className="mb-5 rounded-md border border-warning/30 bg-tint-warning px-5 py-5 sm:px-6" aria-labelledby="confirm-notice-title">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h2 id="confirm-notice-title" className="text-title font-bold text-ink">This notice can no longer be confirmed</h2>
            <Badge tone="warning">Date has passed</Badge>
          </div>
          <p className="mt-1 max-w-prose text-body text-ink">
            Your landlord recorded a notice for you that named <b className="font-bold">{formatDate(awaitingConfirmation.effectiveOn)}</b> as
            the last day. That day has passed without your confirmation, so the notice is not in force and your lease
            carries on. Speak to your landlord about a new end date.
          </p>
          <LinkButton to={`/leases/${lease.id}`} size="sm" className="mt-4">Open your lease</LinkButton>
        </section>
      ) : awaitingConfirmation ? (
        <section className="mb-5 rounded-md border border-warning/30 bg-tint-warning px-5 py-5 sm:px-6" aria-labelledby="confirm-notice-title">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h2 id="confirm-notice-title" className="text-title font-bold text-ink">Your landlord recorded a notice for you</h2>
            <Badge tone="warning">Needs your answer</Badge>
          </div>
          <p className="mt-1 max-w-prose text-body text-ink">
            It says your lease ends on <b className="font-bold">{formatDate(awaitingConfirmation.effectiveOn)}</b>. Confirm it
            if that is what you agreed to. If it is not, say so and the notice is withdrawn. It cannot be confirmed after that day.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <ConfirmNotice leaseId={lease.id} termination={awaitingConfirmation} />
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setDisputing(true)}>
              This is not right
            </Button>
          </div>
        </section>
      ) : attestedNotice ? (
        <section className="mb-5 rounded-md border border-info/30 bg-tint-info px-5 py-5 sm:px-6" aria-labelledby="attested-notice-title">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h2 id="attested-notice-title" className="text-title font-bold text-ink">Your landlord recorded your written notice</h2>
            <Badge tone="info">In force</Badge>
          </div>
          <p className="mt-1 max-w-prose text-body text-ink">
            Your lease ends on <b className="font-bold">{formatDate(attestedNotice.effectiveOn)}</b>. Your landlord attached
            the notice you gave in writing, so it stands without you confirming it here.
          </p>
          {attestedNotice.attestation?.statement ? (
            <p className="mt-2 max-w-prose rounded-sm bg-surface px-3 py-2 text-body text-ink">
              <span className="block text-meta text-ink-muted">What your landlord said</span>
              {attestedNotice.attestation.statement}
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            {attestedNotice.attestation?.evidenceKey ? (
              <Button size="sm" aria-label="Open the written notice" onClick={() => openDocument(attestedNotice.attestation!.evidenceKey!)}>
                Open
              </Button>
            ) : null}
            {disputable ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setDisputing(true)}>
                This is not right
              </Button>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* On a laptop: their money and any notices on the left, what they can do on the right. */}
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-4">
          {/* The one warm panel in the app: where the tenant stands, said plainly. */}
          <section className={`rounded-md px-6 py-7 sm:px-8 ${HERO.tile}`} aria-labelledby="standing-title">
            <p className={`text-body font-semibold ${HERO.label}`}>{HERO.eyebrow}</p>
            <h2 id="standing-title" className="mt-1 font-display text-hero font-bold leading-[1.1] tracking-[-0.02em] text-ink">
              {headline}
            </h2>
            {lease.depositOwingCents > 0 && lease.outstandingCents > 0 ? (
              <p className="mt-3 text-lead text-ink">
                Including your deposit of <Money cents={lease.depositOwingCents} />, due within 7 days of signing.
              </p>
            ) : lease.depositOwingCents > 0 ? (
              <p className="mt-3 text-lead text-ink">Your deposit is due within 7 days of signing.</p>
            ) : null}
            {settled ? (
              <p className="mt-3 text-lead text-ink">Thank you. Nothing is owing on your rent or your deposit.</p>
            ) : (
              <p className="mt-3 max-w-prose text-lead text-ink">
                Pay by EFT with the reference <b className="font-mono font-bold">{lease.ref}</b> exactly, so the bank
                can match it to your unit.
              </p>
            )}
            <div className="mt-5 flex flex-wrap gap-2">
              {settled ? (
                <LinkButton to={`/leases/${lease.id}/rent`} variant="outline">See your statement</LinkButton>
              ) : (
                <>
                  <LinkButton to={`/leases/${lease.id}/rent?proof=1`} variant="primary" size="lg">Send proof of payment</LinkButton>
                  <LinkButton to={`/leases/${lease.id}/rent`} size="lg">Banking details</LinkButton>
                </>
              )}
            </div>
          </section>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Tile label="Rent a month"><Money cents={lease.monthlyRentCents} whole className="text-figure text-ink" /></Tile>
            <Tile label="Your deposit" hint="with interest">
              <Money cents={lease.depositBalanceCents} className="text-figure text-ink" />
            </Tile>
            <Tile label="Lease runs to" className="col-span-2 sm:col-span-1">
              <span className="text-title font-bold leading-[2.1rem] text-ink">{formatDate(lease.terminationEffectiveOn ?? lease.endDate)}</span>
            </Tile>
          </div>

          {upcoming ? (
            <Alert tone="info" title={`Your renewal ${upcoming.ref} starts ${formatDate(upcoming.startDate)}`}>
              <p>It only starts once you and your landlord have both signed it.</p>
              <Button size="sm" variant="outline" className="mt-2" onClick={() => navigate(`/lease/${upcoming.id}`)}>
                Open the new lease
              </Button>
            </Alert>
          ) : null}

          {lease.renewalOffered ? (
            <Alert tone="info" title="You have a renewal offer">
              <p>Open your lease to see the new rent and dates, then accept or decline.</p>
              <LinkButton to={`/leases/${lease.id}`} size="sm" className="mt-2">See the offer</LinkButton>
            </Alert>
          ) : lease.terminationEffectiveOn ? (
            <Alert tone="warning" title={`Your lease ends ${formatDate(lease.terminationEffectiveOn)}`}>
              The exit inspection must happen in the final three days, with you there. If it does not
              happen, the law treats the place as undamaged and nothing can be deducted from your
              deposit.
            </Alert>
          ) : endingIn >= 0 && endingIn <= 60 ? (
            <Alert tone="info" title={`Your lease ends in ${endingIn} days`}>
              Your landlord should be in touch about renewing.
            </Alert>
          ) : endingIn < 0 && lease.status === 'active' ? (
            // A negative count used to read "ends in -40 days". A fixed-term lease that runs past
            // its end date with nobody giving notice carries on month to month (CPA s14).
            <Alert tone="info" title="Your lease has passed its end date and continues month to month." />
          ) : null}
        </div>

        <div className="space-y-4">
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
              <div className="min-w-0">
                <h2 className="text-lead font-bold text-ink">Something broken?</h2>
                <p className="text-meta text-ink-muted">Tell your landlord, with photos.</p>
              </div>
              <Button variant={settled ? 'primary' : 'secondary'} onClick={() => navigate(`/leases/${lease.id}/tickets/new`)}>
                Report a problem
              </Button>
            </div>
          </Card>

          <Card>
            <h2 className="px-5 pb-1 pt-4 text-lead font-bold text-ink">Your home</h2>
            <ul className="divide-y divide-line-soft">
              {actions.map((action) => (
                <li key={action.label}>
                  <Link to={action.to} className="flex items-center gap-3.5 px-5 py-3.5 hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--tb-ring)]">
                    <action.icon className="h-5 w-5 shrink-0 text-brand-600" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block text-lead font-semibold text-ink">{action.label}</span>
                      <span className="block truncate text-meta text-ink-muted">{action.hint}</span>
                    </span>
                    {action.count ? <Badge tone="warning">{action.count} open</Badge> : null}
                    <ChevronRightIcon className="shrink-0 text-ink-muted" />
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={disputing}
        onOpenChange={(next) => !busy && setDisputing(next)}
        title="Is the notice wrong?"
        description="If you did not give this notice, or the date is wrong, withdraw it. Your lease carries on as if notice had never been given, and your landlord is told."
        confirmLabel="Withdraw the notice"
        loading={busy}
        onConfirm={withdrawNotice}
      />
    </main>
  );
}

/** The page title: who it is for, and the place they rent. */
function Greeting({ unit }: { unit: string }) {
  const first = (currentUser()?.name ?? '').trim().split(/\s+/)[0];
  return (
    <header className="mb-5">
      {first ? <p className="text-body text-ink-muted">Hello {first}</p> : null}
      <h1 className="font-display text-display font-bold leading-tight tracking-[-0.01em] text-ink">{unit}</h1>
    </header>
  );
}

/** A small white tile: a label, one bold figure, one muted line. */
function Tile({ label, hint, className = '', children }: { label: string; hint?: string; className?: string; children: ReactNode }) {
  return (
    <Card className={className}>
      <div className="px-5 py-4">
        <p className="text-meta font-semibold text-ink-muted">{label}</p>
        <p className="mt-1">{children}</p>
        {hint ? <p className="text-meta text-ink-muted">{hint}</p> : null}
      </div>
    </Card>
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
      <div className="space-y-3 px-5 py-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-title font-bold text-ink">Your lease of {lease.unit} has ended</h2>
          <Badge tone="neutral">Ended</Badge>
        </div>
        <p className="text-body text-ink-muted">
          {lease.ref} ran to {formatDate(lease.endDate)}. Your deposit statement, inspections and invoices are kept.
        </p>
        <LinkButton to="/documents" variant="secondary">
          Deposit statement and documents
        </LinkButton>
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
    <main className={PAGE.wide}>
      <h1 className="mb-5 font-display text-display font-bold leading-tight tracking-[-0.01em] text-ink">Your applications</h1>
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div>
          {ended ? <EndedLease lease={ended} /> : null}
      <ul className="space-y-3">
        {items.map((item) => {
          const status = applicationStatus(item);
          return (
            <li key={item.id}>
              <Card>
                <div className="space-y-2 px-5 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-title font-bold text-ink">{item.unit}</p>
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </div>
                  <p className="text-meta text-ink-muted">
                    {item.landlord}{item.submittedAt ? `, sent ${formatInstant(item.submittedAt)}` : ''}
                  </p>
                  <p className="text-body text-ink">{status.next}</p>
                  <div className="flex flex-wrap gap-2 pt-1">
                  {item.status === 'draft' || (item.status === 'submitted' && item.documents < 4) ? (
                    <LinkButton variant="primary" size="sm" to={`/apply/${item.id}/documents`}>
                      Upload documents
                    </LinkButton>
                  ) : null}
                  {status.link ? (
                    <LinkButton variant={item.leaseStatus === 'out_for_signature' ? 'primary' : 'secondary'} size="sm" to={status.link.to}>
                      {status.link.label}
                    </LinkButton>
                  ) : null}
                  {applicantCanWithdraw(item) ? (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => setWithdrawing(item)}>
                      Withdraw application
                    </Button>
                  ) : null}
                  </div>
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
        </div>
        <aside className="rounded-md bg-brand-50 px-5 py-5">
          <h2 className="text-lead font-bold text-ink">What happens next</h2>
          <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-body text-ink">
            <li>Upload your four documents, so the landlord can decide.</li>
            <li>The landlord checks your details. You get an email either way.</li>
            <li>If you are approved, the lease appears here to read and sign on your phone.</li>
            <li>Once you have both signed, this page becomes your home: rent, deposit and repairs.</li>
          </ol>
        </aside>
      </div>
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
