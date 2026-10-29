import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, CardBody, Checkbox, Input, Modal, useToast } from '@hlonie/toolbox/ui';
import { formatZar } from '@hlonie/toolbox/utils';
import { api, humanError } from '../api/client';
import { addDays, localToday } from '../lib/dates';
import { formatDate } from '../lib/format';
import { useOpenDocument } from '../lib/open-document';
import { invalidateMoneyCaches } from '../lib/money-caches';
import { Money } from './money';

type Step = 'reminder_1' | 'reminder_3' | 'reminder_7' | 'letter_of_demand';

interface ArrearsStep {
  step: Step; takenOn: string; daysLate: number; outstandingCents: number;
  remedyBy: string | null; documentKey: string | null;
}

interface ArrearsCase {
  id: string; openedOn: string; closedOn: string | null;
  pausedUntil: string | null; pauseReason: string | null; steps: ArrearsStep[];
}

export interface Arrears {
  owing: { outstandingCents: number; oldestDueOn: string; daysLate: number; slipPending: boolean } | null;
  case: ArrearsCase | null;
  next: { step: Step; on: string } | null;
  letter: { allowed: boolean; from: string } | null;
  history: ArrearsCase[];
}

export const STEP_LABEL: Record<Step, string> = {
  reminder_1: 'First reminder',
  reminder_3: 'Second reminder',
  reminder_7: 'Final reminder',
  letter_of_demand: 'Letter of demand',
};

const MAX_PAUSE_DAYS = 60;

/**
 * The arrears ladder on a lease: what went out, what goes next, and the landlord's two
 * decisions, sending the letter of demand and pausing the reminders. A tenant sees the same
 * record, so both sides argue from one history.
 */
export function ArrearsPanel({ leaseId, landlord }: { leaseId: string; landlord: boolean }) {
  const toast = useToast();
  const openDocument = useOpenDocument();
  const queryClient = useQueryClient();
  const { data, refetch } = useQuery({
    queryKey: ['arrears', leaseId],
    queryFn: () => api.get<Arrears>(`/leases/${leaseId}/arrears`),
  });
  const [showLetter, setShowLetter] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [showPause, setShowPause] = useState(false);
  const [pause, setPause] = useState({ until: '', reason: '' });
  const [busy, setBusy] = useState(false);

  if (!data || (!data.owing && !data.case)) return null;
  const today = localToday();
  const steps = data.case?.steps ?? [];
  const letter = steps.find((step) => step.step === 'letter_of_demand');
  const paused = data.case?.pausedUntil ?? null;
  const latestPause = addDays(today, MAX_PAUSE_DAYS);

  const act = async (fn: () => Promise<unknown>, message: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      toast.show({ title: message, tone: 'success' });
      await refetch();
      // Lease, arrears and both reports (the old ['reports'] key matched no query).
      void invalidateMoneyCaches(queryClient);
    } catch (error) {
      toast.show({ title: 'That did not work', description: humanError(error), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mb-4" aria-label="Arrears">
      <p className="label mb-2">{landlord ? 'Arrears' : 'Overdue rent'}</p>
      <Card>
        <CardBody className="space-y-4">
          {data.owing ? (
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <Money cents={data.owing.outstandingCents} className="text-figure text-ink" />
                <p className="text-meta text-ink-muted">
                  Overdue since {formatDate(data.owing.oldestDueOn)}, {data.owing.daysLate}{' '}
                  {data.owing.daysLate === 1 ? 'day' : 'days'} late.
                </p>
              </div>
              {data.owing.slipPending ? (
                <p className="text-meta text-ink-muted">
                  {landlord ? 'A slip is waiting for you. Reminders hold until you check it.' : 'Your slip is with the landlord. Reminders hold until they check it.'}
                </p>
              ) : null}
            </div>
          ) : null}

          {paused ? (
            <Alert tone="info" title={`Reminders paused until ${formatDate(paused)}`}>
              {data.case?.pauseReason}
            </Alert>
          ) : null}

          {letter ? (
            <Alert tone="warning" title={`Letter of demand sent ${formatDate(letter.takenOn)}`}>
              {formatZar(letter.outstandingCents / 100)} to be paid by {formatDate(letter.remedyBy!)}, 20 business days
              from the letter.{' '}
              {landlord
                ? 'If it is not paid by then, you may cancel the lease for breach.'
                : 'If it is not paid by then, the landlord may cancel the lease.'}
            </Alert>
          ) : null}

          <ol className="space-y-2" aria-label="Steps taken">
            {steps.map((step) => (
              <li key={step.step} className="flex items-center justify-between gap-3 border-b border-line-soft pb-2 last:border-0">
                <div className="min-w-0">
                  <p className="text-body font-semibold">{STEP_LABEL[step.step]}</p>
                  <p className="text-xs text-ink-muted">
                    {formatDate(step.takenOn)}, day {step.daysLate}, {formatZar(step.outstandingCents / 100)} owing
                  </p>
                </div>
                {step.documentKey ? (
                  <button
                    type="button"
                    className="shrink-0 text-meta font-bold text-brand-500"
                    onClick={() => openDocument(step.documentKey!)}
                  >
                    PDF
                  </button>
                ) : (
                  <span className="shrink-0 text-xs text-ink-muted">Sent</span>
                )}
              </li>
            ))}
            {data.next ? (
              <li className="flex items-center justify-between gap-3 text-ink-muted">
                <p className="text-body">{STEP_LABEL[data.next.step]}</p>
                <p className="text-xs">{data.next.on <= today ? 'Goes out this morning' : `Due ${formatDate(data.next.on)}`}</p>
              </li>
            ) : null}
          </ol>

          {landlord && data.owing && !letter ? (
            <div className="flex flex-wrap gap-2 border-t border-line pt-3">
              {data.letter ? (
                <Button
                  size="sm"
                  disabled={busy || !data.letter.allowed}
                  onClick={() => {
                    setConfirmed(false);
                    setShowLetter(true);
                  }}
                >
                  {data.letter.allowed ? 'Send letter of demand' : `Letter of demand from ${formatDate(data.letter.from)}`}
                </Button>
              ) : null}
              {data.case ? (
                paused ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => act(() => api.post(`/leases/${leaseId}/arrears/pause`, { until: null }), 'Reminders back on')}
                  >
                    Resume reminders
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      setPause({ until: addDays(today, 14), reason: '' });
                      setShowPause(true);
                    }}
                  >
                    Pause reminders
                  </Button>
                )
              ) : null}
            </div>
          ) : null}

          {data.history.length > 0 ? (
            <details className="text-meta text-ink-muted">
              <summary className="cursor-pointer">Earlier arrears ({data.history.length})</summary>
              <ul className="mt-2 space-y-1">
                {data.history.map((past) => (
                  <li key={past.id}>
                    {formatDate(past.openedOn)} to {formatDate(past.closedOn!)}:{' '}
                    {past.steps.map((step) => STEP_LABEL[step.step]).join(', ') || 'paid before any reminder'}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </CardBody>
      </Card>

      <Modal
        open={showLetter}
        onOpenChange={setShowLetter}
        title="Send the letter of demand"
        description="The tenant gets it by email, and it is filed on this lease."
      >
        <div className="space-y-3 text-body">
          <p>
            It demands {formatZar((data.owing?.outstandingCents ?? 0) / 100)} within 20 business days. That is the notice
            the Consumer Protection Act needs before you can cancel a fixed-term lease for not paying.
          </p>
          <p className="text-meta text-ink-muted">
            Send it once you have checked the account. A payment that arrived but is not recorded yet makes the
            letter wrong, and it cannot be taken back.
          </p>
          <Checkbox
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            label="I have checked the account and the amount is right"
          />
          <Button
            block
            loading={busy}
            disabled={!confirmed}
            onClick={() =>
              act(async () => {
                await api.post(`/leases/${leaseId}/arrears/letter`, {});
                setShowLetter(false);
              }, 'Letter of demand sent')
            }
          >
            Send letter
          </Button>
        </div>
      </Modal>

      <Modal
        open={showPause}
        onOpenChange={setShowPause}
        title="Pause reminders"
        description={`For a payment plan or a dispute. ${MAX_PAUSE_DAYS} days at most, then they start again.`}
      >
        <div className="space-y-3">
          <Input
            type="date"
            aria-label="Paused until"
            min={today}
            max={latestPause}
            value={pause.until}
            onChange={(event) => setPause({ ...pause, until: event.target.value })}
          />
          <Input
            placeholder="Reason, for example a payment plan agreed by phone"
            aria-label="Reason"
            maxLength={200}
            value={pause.reason}
            onChange={(event) => setPause({ ...pause, reason: event.target.value })}
          />
          <Button
            block
            loading={busy}
            disabled={!pause.until || pause.until > latestPause || pause.reason.trim().length < 3}
            onClick={() =>
              act(async () => {
                await api.post(`/leases/${leaseId}/arrears/pause`, { until: pause.until, reason: pause.reason.trim() });
                setShowPause(false);
              }, 'Reminders paused')
            }
          >
            Pause
          </Button>
        </div>
      </Modal>
    </section>
  );
}
