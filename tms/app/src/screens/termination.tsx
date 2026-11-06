import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router';
import {
  Alert, Badge, Button, Card, CardBody, ConfirmDialog, CurrencyInput, Input, PageHeader, useToast,
} from '@hlonie/toolbox/ui';
import { api, humanError } from '../api/client';
import { Money } from '../components/money';
import { formatDate } from '../lib/format';
import { localToday } from '../lib/dates';
import { QueryState } from '../components/query-state';
import { useOpenDocument } from '../lib/open-document';
import { invalidateMoneyCaches } from '../lib/money-caches';
import { PAGE } from '../lib/layout';

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

const RULE_COPY: Record<string, string> = {
  no_deductions: 'Nothing deducted, so the deposit and its interest are due within 7 days of the lease ending.',
  with_deductions: 'Deductions were made, so the balance is due within 14 days of the place being restored.',
  no_inspection: 'No outgoing inspection was held. The law treats the place as undamaged, so nothing may be deducted and the full deposit is due within 21 days.',
};

export function Termination() {
  const { terminationId } = useParams();
  const toast = useToast();
  const openDocument = useOpenDocument();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState({ description: '', amountCents: 0, findingId: '' });
  const [settled, setSettled] = useState<Settlement | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
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
  const openConfirm = () => {
    // A reopened dialog starts from loading, never from the figures it showed last time.
    queryClient.removeQueries({ queryKey: ['settlement-preview', terminationId] });
    setRestoredOn(null);
    setRestoredInput(null);
    setRuleSeen(null);
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

  const settle = () =>
    guarded(async () => {
      try {
        const result = await api.post<Settlement>(
          `/terminations/${terminationId}/settle`,
          withDeductions && restoredOn ? { restoredOn } : {},
        );
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

  return (
    <main className={PAGE.reading}>
      <PageHeader
        title="Then and now"
        description={`${data.summary.unchanged} unchanged, ${data.summary.wearAndTear} fair wear, ${data.summary.deductible} deductible.`}
      />

      {settled ? (
        <Card className="mb-4">
          <CardBody className="space-y-3">
            <p className="label">
              {settled.tenantOwesCents > 0 ? 'Owed by tenant' : 'Refund to tenant'}
            </p>
            <Money
              cents={settled.tenantOwesCents > 0 ? settled.tenantOwesCents : settled.refundCents}
              className="text-hero"
            />
            <div className="space-y-1 border-t border-line-soft pt-3 text-meta">
              <p>Deposit <Money cents={settled.depositCents} /></p>
              <p>Interest <Money cents={settled.interestCents} /></p>
              {settled.deductionsCents > 0 ? (
                <p className="text-danger">Less repairs <Money cents={settled.deductionsCents} /></p>
              ) : null}
              {settled.arrearsCents > 0 ? (
                <p className="text-danger">Less arrears <Money cents={settled.arrearsCents} /></p>
              ) : null}
              {settled.penaltyCents > 0 ? (
                <p className="text-danger">Less cancellation penalty <Money cents={settled.penaltyCents} /></p>
              ) : null}
              {/* The refund includes it, so the lines must too or they do not add up. */}
              {settled.rentCreditCents > 0 ? (
                <p>Plus rent paid in advance <Money cents={settled.rentCreditCents} /></p>
              ) : null}
            </div>
            <Alert tone="info" title={`Payable by ${formatDate(settled.refundDueBy)}`}>
              {RULE_COPY[settled.refundRule]}
            </Alert>
          </CardBody>
        </Card>
      ) : null}

      {data.statementKey ? (
        <Button variant="outline" className="mb-4" onClick={() => openDocument(data.statementKey!)}>
          Open the deposit statement
        </Button>
      ) : null}

      {data.deductions.length > 0 ? (
        <Card className="mb-4">
          <CardBody className="space-y-2">
            <p className="label">
              Deductions recorded
            </p>
            {data.deductions.map((deduction) => (
              <div
                key={deduction.id}
                className="flex items-center justify-between border-b border-line-soft pb-2 last:border-0 last:pb-0"
              >
                <div>
                  <p className="text-body font-semibold">{deduction.description}</p>
                  {deduction.evidenceKey ? (
                    <button
                      type="button"
                      className="text-xs font-bold text-brand-500"
                      onClick={() => openDocument(deduction.evidenceKey!)}
                    >
                      View evidence
                    </button>
                  ) : null}
                </div>
                <div className="flex items-center gap-3">
                  <Money cents={deduction.amountCents} className="text-lead" />
                  {data.status !== 'settled' ? (
                    <button
                      type="button"
                      className="text-meta font-semibold text-danger disabled:opacity-40"
                      disabled={busy}
                      onClick={() => removeDeduction(deduction)}
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </CardBody>
        </Card>
      ) : null}

      <div className="space-y-3">
        {data.items.map((item) => (
          <Card key={`${item.room}-${item.item}`}>
            <CardBody className="space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="text-lead font-semibold">
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

              <div className="grid grid-cols-2 gap-3 text-meta">
                <div className="rounded-sm bg-surface-muted p-2">
                  <p className="label">Move in</p>
                  <p className="font-semibold capitalize">{item.incoming.condition ?? 'not recorded'}</p>
                </div>
                <div className="rounded-sm bg-surface-muted p-2">
                  <p className="label">Move out</p>
                  <p className="font-semibold capitalize">{item.outgoing.condition ?? 'not inspected'}</p>
                </div>
              </div>

              {item.noBaseline ? (
                <p className="text-xs text-ink-muted">
                  The move-in inspection never recorded this, so there is nothing to prove it was
                  undamaged before. It cannot be deducted.
                </p>
              ) : null}

              {item.deductible && item.findingId && deductedFor.has(item.findingId) ? (
                <p className="text-meta">
                  Deducted <Money cents={deductedFor.get(item.findingId)!} className="font-semibold" />. Remove it
                  above to change the amount.
                </p>
              ) : item.deductible ? (
                <div className="flex flex-wrap items-end gap-2">
                  <div className="min-w-[160px] flex-1">
                    <CurrencyInput
                      aria-label={`Deduction amount for ${item.room} ${item.item}`}
                      cents={draft.findingId === item.findingId ? draft.amountCents : 0}
                      onCentsChange={(next) =>
                        setDraft({ description: '', amountCents: next ?? 0, findingId: item.findingId ?? '' })
                      }
                    />
                  </div>
                  <Button
                    size="sm"
                    loading={busy && draft.findingId === item.findingId}
                    disabled={busy || draft.findingId !== item.findingId || draft.amountCents <= 0}
                    onClick={() => addDeduction(item)}
                  >
                    Deduct
                  </Button>
                </div>
              ) : null}
            </CardBody>
          </Card>
        ))}
      </div>

      {!settled && data.status !== 'settled' ? (
        <Button className="mt-5" loading={busy} onClick={openConfirm}>
          Settle the deposit
        </Button>
      ) : null}

      {/* Settling ends the lease and fixes the money for good, so it is never one tap. */}
      <ConfirmDialog
        open={confirming}
        onOpenChange={(next) => !busy && setConfirming(next)}
        title="Settle the deposit?"
        description="This ends the lease, frees the unit and fixes the refund. It cannot be undone."
        confirmLabel="Settle and end the lease"
        loading={busy}
        // Only the figures just fetched for what is on screen may be confirmed.
        disabled={!preview.data || preview.isFetching || preview.isError || !!preview.data.blocker || restoredBad}
        onConfirm={settle}
      >
        {withDeductions && ruleSeen ? (
          <div className="mb-3 space-y-1">
            <label className="block space-y-1">
              <span className="text-xs font-semibold text-ink-muted">Repairs finished on</span>
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
              <span className="block text-xs text-danger">
                Pick a day from {formatDate(ruleSeen.effectiveOn)} to today.
              </span>
            ) : null}
          </div>
        ) : null}
        <SettlementPreview preview={preview} deductions={data.deductions} />
      </ConfirmDialog>

      {settled?.statementKey ? (
        <Button variant="outline" className="ml-2 mt-5" onClick={() => openDocument(settled.statementKey!)}>
          Open the deposit statement
        </Button>
      ) : null}
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
  if (isLoading) return <p className="text-meta text-ink-muted">Working out the refund…</p>;
  if (isError || !data) {
    return <Alert tone="danger" title="The figures could not be loaded">{humanError(error)}</Alert>;
  }
  const owes = data.tenantOwesCents > 0;
  return (
    <div className="space-y-3 text-meta">
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
        <li className="flex justify-between gap-3 border-t border-line pt-1 font-semibold">
          <span>{owes ? 'Owed by the tenant' : 'Refund to the tenant'}</span>
          <Money cents={owes ? data.tenantOwesCents : data.refundCents} />
        </li>
      </ul>
      {data.blocker ? (
        <Alert tone="danger" title="Cannot settle yet">{data.blocker}</Alert>
      ) : (
        <p className="text-ink-muted">
          {owes ? 'The statement records this as owed.' : `Payable by ${formatDate(data.refundDueBy)}.`} {RULE_COPY[data.refundRule]}
        </p>
      )}
    </div>
  );
}
