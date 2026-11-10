import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router';
import {
  Alert, Badge, Button, ConfirmDialog, CurrencyInput, Input, Modal, useToast,
} from '@hlonie/toolbox/ui';
import { api, humanError } from '../api/client';
import { Money } from '../components/money';
import { formatDate } from '../lib/format';
import { localToday } from '../lib/dates';
import { QueryState } from '../components/query-state';
import { useOpenDocument } from '../lib/open-document';
import { invalidateMoneyCaches } from '../lib/money-caches';
import { PAGE } from '../lib/layout';
import { ROW, ROWS, SectionCard } from '../components/core-kit';

interface ComparisonItem {
  room: string;
  item: string;
  incoming: { condition: string | null };
  outgoing: { condition: string | null };
  findingId: string | null;
  noBaseline: boolean;
  notReinspected: boolean;
  worsenedBy: number;
  deductible: boolean;
}

interface Deduction {
  id: string;
  description: string;
  amountCents: number;
  findingId: string | null;
  evidenceKey: string | null;
}

interface Comparison {
  status: string;
  statementKey: string | null;
  deductions: Deduction[];
  items: ComparisonItem[];
  summary: { unchanged: number; wearAndTear: number; deductible: number; noBaseline: number; notReinspected: number };
}

interface SettlementFigures {
  heldCents: number; deductionsCents: number; arrearsCents: number; penaltyCents: number;
  rentCreditCents: number; refundCents: number; tenantOwesCents: number;
  refundRule: string; refundDueBy: string; blocker: string | null; effectiveOn: string;
}

interface Settlement {
  depositCents: number; interestCents: number; heldCents: number;
  deductionsCents: number; arrearsCents: number; penaltyCents: number;
  rentCreditCents: number; refundCents: number; tenantOwesCents: number;
  refundRule: string; refundDueBy: string; statementKey: string | null;
}

/** The refund as the lease records it once the deposit is settled. */
interface RefundState {
  effectiveOn: string; refundDueBy: string | null;
  refundCents?: number | null; refundPaidOn?: string | null; refundReference?: string | null;
}

const RULE_COPY: Record<string, string> = {
  no_deductions: 'Nothing deducted, so the deposit and its interest are due within 7 days of the lease ending.',
  with_deductions: 'Deductions were made, so the balance is due within 14 days of the place being restored.',
  no_inspection: 'No outgoing inspection was held. The law treats the place as undamaged, so nothing may be deducted and the full deposit is due within 21 days.',
};

const LABEL = 'text-meta font-semibold text-ink';
const HINT = 'text-meta text-ink-muted';

export function Termination() {
  const { terminationId } = useParams();
  const toast = useToast();
  const openDocument = useOpenDocument();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState({ description: '', amountCents: 0, findingId: '' });
  // A deduction with no inspection finding behind it: cleaning, lost keys, an unpaid utility.
  const [other, setOther] = useState<{ description: string; amountCents: number | null } | null>(null);
  const [settled, setSettled] = useState<Settlement | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // The reference on the refund payment, so the statement and the bank line can be matched.
  const [refundReference, setRefundReference] = useState('');
  // The day the repairs were finished. With deductions the 14-day refund clock runs from it
  // (RHA s5(3)), not from the day the landlord settles. Null: not chosen, the server uses today.
  const [restoredOn, setRestoredOn] = useState<string | null>(null);
  // What the date field shows. A half-typed date (Chrome fires year 0002, 0020, ...) stays here
  // and never reaches the preview query, which the server would refuse.
  const [restoredInput, setRestoredInput] = useState<string | null>(null);
  // The rule and end date from the last figures. The date field keys off these, not the live
  // preview, so it stays on screen while new figures load.
  const [ruleSeen, setRuleSeen] = useState<{ withDeductions: boolean; effectiveOn: string } | null>(null);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['comparison', terminationId],
    queryFn: () => api.get<Comparison>(`/terminations/${terminationId}/comparison`),
  });
  const preview = useSettlementPreview(terminationId!, confirming, restoredOn);
  // The same figures, kept beside the page while deductions are added. Its own key, so opening
  // the dialog (which starts its figures afresh) does not blank the side card.
  const open = !!data && data.status !== 'settled' && data.status !== 'withdrawn' && !settled;
  const summary = useQuery({
    queryKey: ['settlement-summary', terminationId],
    queryFn: () => api.get<SettlementFigures>(`/terminations/${terminationId}/settlement`),
    enabled: open,
    staleTime: 0,
  });
  // The refund the statement promised and whether it has been paid live on the lease, and the
  // settlement only knows its own id: find the lease through the list, ended ones included.
  const isSettled = !!settled || data?.status === 'settled';
  const leases = useQuery({
    queryKey: ['leases', 'with-ended'],
    queryFn: () => api.get<{ items: { id: string; terminationId: string | null }[] }>('/leases', { query: { include: 'ended' } }),
    enabled: isSettled,
    retry: false,
  });
  const leaseId = leases.data?.items.find((item) => item.terminationId === terminationId)?.id;
  const lease = useQuery({
    queryKey: ['lease', leaseId],
    queryFn: () => api.get<{ termination: RefundState | null }>(`/leases/${leaseId}`),
    enabled: isSettled && !!leaseId,
    retry: false,
  });
  const [refundForm, setRefundForm] = useState<{ paidOn: string; reference: string } | null>(null);
  // What the server answered when the refund was marked paid here, until the lease reloads.
  const [refundSaved, setRefundSaved] = useState<{ refundPaidOn: string; refundReference: string } | null>(null);
  const openConfirm = () => {
    // A reopened dialog starts from loading, never from the figures it showed last time.
    queryClient.removeQueries({ queryKey: ['settlement-preview', terminationId] });
    setRestoredOn(null);
    setRestoredInput(null);
    setRuleSeen(null);
    setRefundReference('');
    setConfirming(true);
  };
  useEffect(() => {
    if (preview.data) {
      setRuleSeen({ withDeductions: preview.data.refundRule === 'with_deductions', effectiveOn: preview.data.effectiveOn });
    }
  }, [preview.data]);
  const withDeductions = ruleSeen?.withDeductions ?? false;
  const today = localToday();
  const restoredShown = restoredInput ?? restoredOn ?? today;
  const restoredValid = (day: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(day) && !!ruleSeen && day >= ruleSeen.effectiveOn && day <= today;
  // A typed day outside the range is on screen, so the figures shown are not for it.
  // Untouched, the field shows today and the server checks that.
  const restoredBad = withDeductions && restoredInput !== null && !restoredValid(restoredInput);
  // Settling ends the lease, so it waits for the last day to pass. The server refuses it too;
  // the button used to stay live and fail with "Cannot settle yet".
  const tooEarly = !!preview.data?.effectiveOn && today < preview.data.effectiveOn;

  // Settling moves money, so nothing here runs twice at once.
  const guarded = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  const changed = () => {
    // The lease page shows the termination's status and deduction count.
    queryClient.invalidateQueries({ queryKey: ['lease'] });
    queryClient.invalidateQueries({ queryKey: ['leases'] });
    queryClient.invalidateQueries({ queryKey: ['settlement-summary', terminationId] });
    refetch();
  };

  const addDeduction = (item: ComparisonItem) =>
    guarded(async () => {
      try {
        await api.post(`/terminations/${terminationId}/deductions`, {
          findingId: item.findingId,
          description: `${item.room} · ${item.item}`,
          amountCents: draft.amountCents,
        });
        toast.show({ title: 'Deduction added', tone: 'success' });
        setDraft({ description: '', amountCents: 0, findingId: '' });
        changed();
      } catch (error) {
        toast.show({ title: 'Refused', description: humanError(error), tone: 'danger' });
      }
    });

  const addOtherDeduction = () =>
    guarded(async () => {
      if (!other) return;
      try {
        await api.post(`/terminations/${terminationId}/deductions`, {
          description: other.description.trim(),
          amountCents: other.amountCents,
        });
        toast.show({ title: 'Deduction added', tone: 'success' });
        setOther(null);
        changed();
      } catch (error) {
        toast.show({ title: 'Refused', description: humanError(error), tone: 'danger' });
      }
    });

  const settle = () =>
    guarded(async () => {
      try {
        const reference = refundReference.trim();
        const result = await api.post<Settlement>(`/terminations/${terminationId}/settle`, {
          ...(withDeductions && restoredOn ? { restoredOn } : {}),
          ...(reference ? { refundReference: reference } : {}),
        });
        setConfirming(false);
        setSettled(result);
        toast.show({ title: 'Deposit settled', tone: 'success' });
        changed();
        // Settling ends the lease and moves money: statements, arrears and reports change, and
        // the unit falls vacant on the properties list.
        void invalidateMoneyCaches(queryClient);
        queryClient.invalidateQueries({ queryKey: ['properties'] });
      } catch (error) {
        setConfirming(false);
        toast.show({ title: 'Cannot settle yet', description: humanError(error), tone: 'danger' });
      }
    });

  const markRefundPaid = () =>
    guarded(async () => {
      if (!refundForm) return;
      try {
        const saved = await api.post<{ refundPaidOn: string; refundReference: string }>(
          `/terminations/${terminationId}/refund-paid`,
          { paidOn: refundForm.paidOn, reference: refundForm.reference.trim() },
        );
        setRefundSaved({ refundPaidOn: saved.refundPaidOn ?? refundForm.paidOn, refundReference: saved.refundReference ?? refundForm.reference.trim() });
        setRefundForm(null);
        toast.show({ title: 'Refund marked as paid', tone: 'success' });
        queryClient.invalidateQueries({ queryKey: ['lease'] });
      } catch (error) {
        toast.show({ title: 'Not saved', description: humanError(error), tone: 'danger' });
      }
    });

  const removeDeduction = (deduction: Deduction) =>
    guarded(async () => {
      try {
        await api.delete(`/terminations/${terminationId}/deductions/${deduction.id}`);
        toast.show({ title: 'Deduction removed', tone: 'info' });
        changed();
      } catch (error) {
        toast.show({ title: 'Not removed', description: humanError(error), tone: 'danger' });
      }
    });

  if (!data) {
    return <QueryState isLoading={isLoading} isError={isError} error={error} onRetry={refetch} what="This settlement" />;
  }

  // One deduction per finding: the card used to keep offering Deduct, so the same damage
  // could be charged twice.
  const deductedFor = new Map<string, number>();
  for (const deduction of data.deductions) {
    if (deduction.findingId) {
      deductedFor.set(deduction.findingId, (deductedFor.get(deduction.findingId) ?? 0) + deduction.amountCents);
    }
  }
  const done = !!settled || data.status === 'settled';
  const deductionsTotal = data.deductions.reduce((sum, deduction) => sum + deduction.amountCents, 0);
  const figures = summary.data;
  const owes = (figures?.tenantOwesCents ?? 0) > 0;
  const statementKey = settled?.statementKey ?? data.statementKey;
  const line = 'flex items-baseline justify-between gap-4';
  const onLease = lease.data?.termination ?? null;
  const refundCents = settled ? (settled.tenantOwesCents > 0 ? 0 : settled.refundCents) : onLease?.refundCents ?? 0;
  const refundPaidOn = refundSaved?.refundPaidOn ?? onLease?.refundPaidOn ?? null;
  const refundPaidReference = refundSaved?.refundReference ?? onLease?.refundReference ?? null;
  const refundDueBy = settled?.refundDueBy ?? onLease?.refundDueBy ?? null;
  // The refund cannot have been paid before the lease ended, nor in the future.
  const refundFrom = onLease?.effectiveOn ?? ruleSeen?.effectiveOn ?? null;
  const refundFormBad =
    !refundForm || !/^\d{4}-\d{2}-\d{2}$/.test(refundForm.paidOn) || refundForm.paidOn > today ||
    (!!refundFrom && refundForm.paidOn < refundFrom) || refundForm.reference.trim().length < 1 || refundForm.reference.trim().length > 60;

  return (
    <main className={PAGE.wide}>
      <header className="mb-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="font-display text-display font-bold leading-tight tracking-[-0.01em] text-ink">Deposit settlement</h1>
          <Badge tone={done ? 'success' : data.status === 'withdrawn' ? 'neutral' : 'info'}>
            {done ? 'Settled' : data.status === 'withdrawn' ? 'Notice withdrawn' : 'Not settled yet'}
          </Badge>
        </div>
        <p className="mt-1 text-body text-ink-muted">
          Move-in against move-out: {data.summary.unchanged} unchanged, {data.summary.wearAndTear} fair wear,{' '}
          {data.summary.deductible} deductible.
        </p>
      </header>

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        {/* First on a phone, down the right on a laptop: the money, and the one button that fixes it. */}
        <aside className="min-w-0 space-y-6 lg:sticky lg:top-6 lg:col-start-2 lg:row-start-1">
          {settled ? (
            <SectionCard title={settled.tenantOwesCents > 0 ? 'Owed by tenant' : 'Refund to tenant'}>
              <div className="space-y-4 px-5 py-4">
                <Money
                  cents={settled.tenantOwesCents > 0 ? settled.tenantOwesCents : settled.refundCents}
                  className={`block text-hero leading-tight ${settled.tenantOwesCents > 0 ? 'text-danger' : 'text-ink'}`}
                />
                <div className="space-y-1.5 border-t border-line-soft pt-3 text-body">
                  <p className={line}><span>Deposit</span> <Money cents={settled.depositCents} /></p>
                  <p className={line}><span>Interest</span> <Money cents={settled.interestCents} /></p>
                  {settled.deductionsCents > 0 ? (
                    <p className={`${line} text-danger`}><span>Less repairs</span> <Money cents={settled.deductionsCents} /></p>
                  ) : null}
                  {settled.arrearsCents > 0 ? (
                    <p className={`${line} text-danger`}><span>Less arrears</span> <Money cents={settled.arrearsCents} /></p>
                  ) : null}
                  {settled.penaltyCents > 0 ? (
                    <p className={`${line} text-danger`}><span>Less cancellation penalty</span> <Money cents={settled.penaltyCents} /></p>
                  ) : null}
                  {/* The refund includes it, so the lines must too or they do not add up. */}
                  {settled.rentCreditCents > 0 ? (
                    <p className={line}><span>Plus rent paid in advance</span> <Money cents={settled.rentCreditCents} /></p>
                  ) : null}
                </div>
                <Alert tone="info" title={`Payable by ${formatDate(settled.refundDueBy)}`}>
                  {RULE_COPY[settled.refundRule]}
                </Alert>
              </div>
            </SectionCard>
          ) : done ? (
            <SectionCard title="Settlement">
              <p className={`px-5 py-4 ${HINT}`}>
                This deposit is settled and the lease has ended. The statement carries the final figures.
              </p>
            </SectionCard>
          ) : (
            <SectionCard title="Settlement so far">
              <div className="space-y-4 px-5 py-4">
                {figures ? (
                  <>
                    <div>
                      <p className="text-meta font-semibold text-ink-muted">{owes ? 'Tenant will owe' : 'Refund so far'}</p>
                      <Money
                        whole
                        cents={owes ? figures.tenantOwesCents : figures.refundCents}
                        className={`block text-figure leading-tight ${owes ? 'text-danger' : 'text-ink'}`}
                      />
                    </div>
                    <dl className="space-y-1.5 border-t border-line-soft pt-3 text-body">
                      <div className={line}><dt>Deposit and interest</dt><dd><Money cents={figures.heldCents} /></dd></div>
                      <div className={`${line} ${figures.deductionsCents > 0 ? 'text-danger' : 'text-ink-muted'}`}>
                        <dt>Deductions ({data.deductions.length})</dt><dd><Money cents={-figures.deductionsCents} /></dd>
                      </div>
                      {figures.arrearsCents > 0 ? (
                        <div className={`${line} text-danger`}><dt>Unpaid rent</dt><dd><Money cents={-figures.arrearsCents} /></dd></div>
                      ) : null}
                      {figures.penaltyCents > 0 ? (
                        <div className={`${line} text-danger`}><dt>Cancellation penalty</dt><dd><Money cents={-figures.penaltyCents} /></dd></div>
                      ) : null}
                      {figures.rentCreditCents > 0 ? (
                        <div className={line}><dt>Rent paid ahead</dt><dd><Money cents={figures.rentCreditCents} /></dd></div>
                      ) : null}
                    </dl>
                    {figures.effectiveOn && today < figures.effectiveOn ? (
                      <p className={HINT}>
                        The lease runs until {formatDate(figures.effectiveOn)}. You can line up deductions now and settle
                        once the tenant has moved out.
                      </p>
                    ) : owes ? (
                      <p className={HINT}>The statement records this as owed by the tenant.</p>
                    ) : (
                      <p className={HINT}>
                        Refund deadline: <span className="font-semibold text-ink">{formatDate(figures.refundDueBy)}</span>
                        {figures.refundRule === 'with_deductions' ? ', if repairs finish today.' : '.'}
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <div className={`${line} text-body`}>
                      <span>Deductions ({data.deductions.length})</span>
                      <Money cents={deductionsTotal} />
                    </div>
                    <p className={HINT}>
                      {summary.isError
                        ? 'The refund could not be worked out just now. It is shown before you confirm.'
                        : 'Working out the refund…'}
                    </p>
                  </>
                )}
                {data.status !== 'withdrawn' ? (
                  <Button block loading={busy} onClick={openConfirm}>
                    Settle the deposit
                  </Button>
                ) : null}
              </div>
            </SectionCard>
          )}

          {done && refundCents > 0 ? (
            <SectionCard title="Refund to the tenant" action={<Badge tone={refundPaidOn ? 'success' : 'warning'}>{refundPaidOn ? 'Paid' : 'Not paid yet'}</Badge>}>
              <div className="space-y-3 px-5 py-4">
                <Money whole cents={refundCents} className="block text-figure leading-tight text-ink" />
                {refundPaidOn ? (
                  <>
                    <p className="text-body text-ink">
                      Paid on <span className="font-semibold">{formatDate(refundPaidOn)}</span>
                      {refundPaidReference ? <>, reference <span className="font-semibold">{refundPaidReference}</span></> : null}.
                    </p>
                    <Button
                      block
                      variant="outline"
                      disabled={busy}
                      onClick={() => setRefundForm({ paidOn: refundPaidOn, reference: refundPaidReference ?? '' })}
                    >
                      Correct the refund details
                    </Button>
                  </>
                ) : (
                  <>
                    <p className={HINT}>
                      {refundDueBy ? `Due to the tenant by ${formatDate(refundDueBy)}. ` : ''}
                      Once you have paid it, record the date and reference so the deadline is shown as met.
                    </p>
                    <Button block disabled={busy} onClick={() => setRefundForm({ paidOn: today, reference: '' })}>
                      Mark refund paid
                    </Button>
                  </>
                )}
              </div>
            </SectionCard>
          ) : null}

          {statementKey ? (
            <Button block variant="outline" onClick={() => openDocument(statementKey)}>
              Open the deposit statement
            </Button>
          ) : null}
        </aside>

        <div className="min-w-0 space-y-6 lg:col-start-1 lg:row-start-1">
          {data.deductions.length > 0 || !done ? (
            <SectionCard
              title="Deductions recorded"
              count={data.deductions.length > 0 ? data.deductions.length : undefined}
              action={
                !done && data.status !== 'withdrawn' ? (
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => setOther({ description: '', amountCents: null })}>
                    Add another deduction
                  </Button>
                ) : null
              }
            >
              {data.deductions.length === 0 ? (
                <p className={`px-5 py-4 ${HINT}`}>
                  None yet. Deduct damage from the list below, or add another cost such as cleaning or lost keys.
                  Keep the slips: the tenant may ask for them.
                </p>
              ) : (
                <ul className={ROWS}>
                  {data.deductions.map((deduction) => (
                    <li key={deduction.id} className={ROW}>
                      <div className="min-w-0">
                        <p className="text-body font-bold text-ink">{deduction.description}</p>
                        <p className={HINT}>{deduction.findingId ? 'From the move-out inspection' : 'Added by you'}</p>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center justify-end gap-3">
                        <Money cents={deduction.amountCents} className="text-body" />
                        {deduction.evidenceKey ? (
                          <Button
                            size="sm"
                            variant="outline"
                            aria-label={`View evidence for ${deduction.description}`}
                            onClick={() => openDocument(deduction.evidenceKey!)}
                          >
                            View evidence
                          </Button>
                        ) : null}
                        {data.status !== 'settled' ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            aria-label={`Remove the deduction for ${deduction.description}`}
                            onClick={() => removeDeduction(deduction)}
                          >
                            Remove
                          </Button>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          ) : null}

          <SectionCard title="Then and now" count={data.items.length > 0 ? data.items.length : undefined}>
            {data.items.length === 0 ? (
              <p className={`px-5 py-4 ${HINT}`}>
                Nothing to compare yet. Items appear here once the move-out inspection is done, set against the
                move-in record.
              </p>
            ) : (
              <ul className={ROWS}>
                {data.items.map((item) => (
                  <li key={`${item.room}-${item.item}`} className="space-y-3 px-5 py-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="text-body font-bold text-ink">
                        {item.room} · {item.item}
                      </p>
                      {item.deductible ? (
                        <Badge tone="danger">Deductible</Badge>
                      ) : item.noBaseline ? (
                        <Badge tone="warning">No move-in record</Badge>
                      ) : item.notReinspected ? (
                        <Badge tone="warning">Not re-inspected</Badge>
                      ) : item.worsenedBy === 1 ? (
                        <Badge tone="neutral">Fair wear</Badge>
                      ) : (
                        <Badge tone="success">Unchanged</Badge>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="rounded-sm bg-surface-muted px-3 py-2">
                        <p className="text-meta text-ink-muted">Move in</p>
                        <p className="text-body font-semibold capitalize text-ink">{item.incoming.condition ?? 'not recorded'}</p>
                      </div>
                      <div className={`rounded-sm px-3 py-2 ${item.deductible ? 'bg-tint-danger' : 'bg-surface-muted'}`}>
                        <p className="text-meta text-ink-muted">Move out</p>
                        <p className="text-body font-semibold capitalize text-ink">{item.outgoing.condition ?? 'not inspected'}</p>
                      </div>
                    </div>

                    {item.noBaseline ? (
                      <p className={HINT}>
                        The move-in inspection never recorded this, so there is nothing to prove it was
                        undamaged before. It cannot be deducted.
                      </p>
                    ) : null}

                    {item.deductible && item.findingId && deductedFor.has(item.findingId) ? (
                      <p className="text-body">
                        Deducted <Money cents={deductedFor.get(item.findingId)!} className="font-semibold" />. Remove it
                        above to change the amount.
                      </p>
                    ) : item.deductible && !done ? (
                      <div className="flex flex-wrap items-end gap-2">
                        <div className="min-w-40 flex-1">
                          <CurrencyInput
                            aria-label={`Deduction amount for ${item.room} ${item.item}`}
                            cents={draft.findingId === item.findingId ? draft.amountCents : 0}
                            onCentsChange={(next) =>
                              setDraft({ description: '', amountCents: next ?? 0, findingId: item.findingId ?? '' })
                            }
                          />
                        </div>
                        <Button
                          variant="secondary"
                          loading={busy && draft.findingId === item.findingId}
                          disabled={busy || draft.findingId !== item.findingId || draft.amountCents <= 0}
                          aria-label={`Deduct for ${item.room} ${item.item}`}
                          onClick={() => addDeduction(item)}
                        >
                          Deduct
                        </Button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>
      </div>

      <Modal
        open={other !== null}
        onOpenChange={(next) => { if (!next && !busy) setOther(null); }}
        title="Add another deduction"
        description="For a cost the inspection list does not cover, such as cleaning, lost keys or an unpaid utility."
        size="sm"
      >
        {other ? (
          <div className="space-y-4">
            <label className="block space-y-1.5">
              <span className={LABEL}>What it is for</span>
              <Input
                aria-label="What it is for"
                maxLength={200}
                placeholder="For example, carpet cleaning"
                value={other.description}
                onChange={(event) => setOther({ ...other, description: event.target.value })}
              />
            </label>
            <label className="block space-y-1.5">
              <span className={LABEL}>Amount</span>
              <CurrencyInput
                aria-label="Deduction amount"
                cents={other.amountCents}
                onCentsChange={(next) => setOther({ ...other, amountCents: next })}
              />
            </label>
            <p className={HINT}>
              It comes off the deposit and prints on the statement. Keep the invoice or slip: the tenant may ask
              to see it.
            </p>
            <Button
              block
              loading={busy}
              disabled={other.description.trim().length < 3 || !other.amountCents || other.amountCents <= 0}
              onClick={addOtherDeduction}
            >
              Add the deduction
            </Button>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={refundForm !== null}
        onOpenChange={(next) => { if (!next && !busy) setRefundForm(null); }}
        title="Mark refund paid"
        description="The day the money left your account, and the reference on the payment."
        size="sm"
      >
        {refundForm ? (
          <div className="space-y-4">
            <label className="block space-y-1.5">
              <span className={LABEL}>Paid on</span>
              <Input
                type="date"
                aria-label="Paid on"
                value={refundForm.paidOn}
                min={refundFrom ?? undefined}
                max={today}
                onChange={(event) => setRefundForm({ ...refundForm, paidOn: event.target.value })}
              />
            </label>
            <label className="block space-y-1.5">
              <span className={LABEL}>Payment reference</span>
              <Input
                aria-label="Payment reference"
                maxLength={60}
                placeholder="As it shows on your bank statement"
                value={refundForm.reference}
                onChange={(event) => setRefundForm({ ...refundForm, reference: event.target.value })}
              />
            </label>
            {refundForm.paidOn && (refundForm.paidOn > today || (!!refundFrom && refundForm.paidOn < refundFrom)) ? (
              <p role="alert" className="text-meta text-danger">
                Pick a day from {refundFrom ? formatDate(refundFrom) : 'the end of the lease'} to today.
              </p>
            ) : null}
            <Button block loading={busy} disabled={refundFormBad} onClick={markRefundPaid}>
              Save
            </Button>
          </div>
        ) : null}
      </Modal>

      {/* Settling ends the lease and fixes the money for good, so it is never one tap. */}
      <ConfirmDialog
        open={confirming}
        onOpenChange={(next) => !busy && setConfirming(next)}
        title="Settle the deposit?"
        description="This ends the lease, frees the unit and fixes the refund. It cannot be undone."
        confirmLabel="Settle and end the lease"
        loading={busy}
        // Only the figures just fetched for what is on screen may be confirmed.
        disabled={
          !preview.data || preview.isFetching || preview.isError || !!preview.data.blocker || restoredBad || tooEarly ||
          refundReference.length > 60
        }
        onConfirm={settle}
      >
        {withDeductions && ruleSeen ? (
          <div className="mb-4 space-y-1.5">
            <label className="block space-y-1.5">
              <span className={LABEL}>Repairs finished on</span>
              <Input
                type="date"
                value={restoredShown}
                min={ruleSeen.effectiveOn}
                max={today}
                onChange={(event) => {
                  const day = event.target.value;
                  setRestoredInput(day);
                  if (restoredValid(day)) setRestoredOn(day);
                }}
              />
            </label>
            {restoredBad ? (
              <span className="block text-meta text-danger">
                Pick a day from {formatDate(ruleSeen.effectiveOn)} to today.
              </span>
            ) : null}
          </div>
        ) : null}
        <SettlementPreview preview={preview} deductions={data.deductions} />
        {tooEarly && preview.data && !preview.data.blocker ? (
          <Alert tone="danger" title="Cannot settle yet" className="mt-3">
            The lease runs until {formatDate(preview.data.effectiveOn)}. The deposit is settled after the tenant has moved out.
          </Alert>
        ) : null}
        {preview.data && !preview.data.blocker && !tooEarly && preview.data.tenantOwesCents === 0 && preview.data.refundCents > 0 ? (
          <label className="mt-4 block space-y-1.5">
            <span className={LABEL}>Refund reference (optional)</span>
            <Input
              aria-label="Refund reference"
              maxLength={60}
              placeholder="As it will show on the tenant's bank statement"
              value={refundReference}
              onChange={(event) => setRefundReference(event.target.value)}
            />
          </label>
        ) : null}
      </ConfirmDialog>
    </main>
  );
}

/** Fetched each time the dialog opens, so it reflects payments and deductions made since. */
const useSettlementPreview = (terminationId: string, open: boolean, restoredOn: string | null) =>
  useQuery({
    queryKey: ['settlement-preview', terminationId, restoredOn],
    queryFn: () =>
      api.get<SettlementFigures>(`/terminations/${terminationId}/settlement`, {
        query: restoredOn ? { restoredOn } : {},
      }),
    enabled: open,
    staleTime: 0,
    gcTime: 0,
  });

/** The settlement in figures before it happens: the same numbers the statement will carry. */
function SettlementPreview({
  preview,
  deductions,
}: {
  preview: ReturnType<typeof useSettlementPreview>;
  deductions: Deduction[];
}) {
  const { data, isLoading, isError, error } = preview;
  if (isLoading) return <p className="text-meta text-ink-muted">Working out the figures…</p>;
  if (isError || !data) {
    return <Alert tone="danger" title="The figures could not be loaded">{humanError(error)}</Alert>;
  }
  const owes = data.tenantOwesCents > 0;
  return (
    <div className="space-y-3 text-body">
      <ul className="space-y-1">
        <li className="flex justify-between gap-3">
          <span>Deposit and interest held</span>
          <Money cents={data.heldCents} />
        </li>
        {deductions.map((deduction) => (
          <li key={deduction.id} className="flex justify-between gap-3 text-danger">
            <span>Less {deduction.description}</span>
            <Money cents={-deduction.amountCents} />
          </li>
        ))}
        {data.arrearsCents > 0 ? (
          <li className="flex justify-between gap-3 text-danger">
            <span>Less unpaid rent</span>
            <Money cents={-data.arrearsCents} />
          </li>
        ) : null}
        {data.penaltyCents > 0 ? (
          <li className="flex justify-between gap-3 text-danger">
            <span>Less cancellation penalty</span>
            <Money cents={-data.penaltyCents} />
          </li>
        ) : null}
        {data.rentCreditCents > 0 ? (
          <li className="flex justify-between gap-3">
            <span>Plus rent paid in advance</span>
            <Money cents={data.rentCreditCents} />
          </li>
        ) : null}
        <li className="flex justify-between gap-3 border-t border-line pt-2 font-bold">
          <span>{owes ? 'Owed by the tenant' : 'Refund to the tenant'}</span>
          <Money cents={owes ? data.tenantOwesCents : data.refundCents} />
        </li>
      </ul>
      {data.blocker ? (
        <Alert tone="danger" title="Cannot settle yet">{data.blocker}</Alert>
      ) : (
        <p className="text-meta text-ink-muted">
          {owes ? 'The statement records this as owed.' : `Payable by ${formatDate(data.refundDueBy)}.`} {RULE_COPY[data.refundRule]}
        </p>
      )}
    </div>
  );
}
