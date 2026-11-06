import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, ConfirmDialog, useToast } from '@hlonie/toolbox/ui';
import { formatZar } from '@hlonie/toolbox/utils';
import { api, humanError } from '../api/client';
import { formatDate } from '../lib/format';

export interface NoticeToConfirm {
  id: string;
  status: string;
  reason?: string;
  effectiveOn: string;
  noticeGivenOn: string;
  awaitingTenant?: boolean;
  penaltyCents?: number;
}

/** The notice as the tenant reads it: their own words, not the server's reason codes. */
const REASON_FOR_TENANT: Record<string, string> = {
  mutual: 'You and your landlord agreed to end the lease.',
  early_tenant: 'You are leaving before the lease ends.',
  end_of_term: 'You are leaving when the lease ends.',
};

/**
 * Whether the tenant still has to confirm a notice the landlord recorded for them. Until they do,
 * the deposit cannot be settled, and nothing else in the app lets them confirm it.
 */
export function needsTenantConfirmation(
  viewer: { isLandlord: boolean; isTenant: boolean },
  termination: NoticeToConfirm | null | undefined,
): termination is NoticeToConfirm {
  if (!termination || !viewer.isTenant || viewer.isLandlord) return false;
  if (termination.status === 'withdrawn' || termination.status === 'settled') return false;
  return Boolean(termination.awaitingTenant);
}

/** "Confirm the notice", with a dialog that says what is being confirmed before it is sent. */
export function ConfirmNotice({ leaseId, termination }: { leaseId: string; termination: NoticeToConfirm }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const penalty = termination.penaltyCents ?? 0;

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.post(`/terminations/${termination.id}/confirm`, {});
      setOpen(false);
      toast.show({ title: 'Notice confirmed', description: 'Your landlord is told.', tone: 'success' });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['lease', leaseId] }),
        queryClient.invalidateQueries({ queryKey: ['leases'] }),
      ]);
    } catch (error) {
      toast.show({ title: 'That did not work', description: humanError(error), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button size="sm" disabled={busy} onClick={() => setOpen(true)}>
        Confirm the notice
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => !busy && setOpen(next)}
        title="Confirm the notice?"
        description="Your landlord recorded this notice for you. Confirm it only if it is what you agreed to."
        confirmLabel="Confirm the notice"
        loading={busy}
        onConfirm={confirm}
      >
        <dl className="space-y-2 text-body">
          {termination.reason && REASON_FOR_TENANT[termination.reason] ? (
            <div>
              <dt className="text-meta text-ink-muted">Notice</dt>
              <dd className="text-ink">{REASON_FOR_TENANT[termination.reason]}</dd>
            </div>
          ) : null}
          <div>
            <dt className="text-meta text-ink-muted">Given on</dt>
            <dd className="text-ink">{formatDate(termination.noticeGivenOn)}</dd>
          </div>
          <div>
            <dt className="text-meta text-ink-muted">Last day of the lease</dt>
            <dd className="font-semibold text-ink">{formatDate(termination.effectiveOn)}</dd>
          </div>
          {penalty > 0 ? (
            <div>
              <dt className="text-meta text-ink-muted">Cancellation penalty</dt>
              <dd className="text-ink">{formatZar(penalty / 100)}, taken from your deposit at settlement</dd>
            </div>
          ) : null}
        </dl>
      </ConfirmDialog>
    </>
  );
}
