import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router';
import {
  Alert, Badge, Button, Card, CardBody, CurrencyInput, PageHeader, useToast,
} from '@hlonie/toolbox/ui';
import { api, humanError } from '../api/client';
import { Money } from '../components/money';
import { formatDate } from '../lib/format';
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

interface Settlement {
  depositCents: number; interestCents: number; heldCents: number;
  deductionsCents: number; arrearsCents: number; penaltyCents: number;
  refundCents: number; tenantOwesCents: number;
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

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['comparison', terminationId],
    queryFn: () => api.get<Comparison>(`/terminations/${terminationId}/comparison`),
  });

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
        const result = await api.post<Settlement>(`/terminations/${terminationId}/settle`, {});
        setSettled(result);
        toast.show({ title: 'Deposit settled', tone: 'success' });
        changed();
        // Settling ends the lease and moves money: statements, arrears and reports change, and
        // the unit falls vacant on the properties list.
        void invalidateMoneyCaches(queryClient);
        queryClient.invalidateQueries({ queryKey: ['properties'] });
      } catch (error) {
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

              {item.deductible ? (
                <div className="flex flex-wrap items-end gap-2">
                  <div className="min-w-[160px] flex-1">
                    <CurrencyInput
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
        <Button className="mt-5" loading={busy} onClick={settle}>
          Settle the deposit
        </Button>
      ) : null}

      {settled?.statementKey ? (
        <Button variant="outline" className="ml-2 mt-5" onClick={() => openDocument(settled.statementKey!)}>
          Open the deposit statement
        </Button>
      ) : null}
    </main>
  );
}
