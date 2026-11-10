import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  ConfirmDialog,
  PageHeader,
  ProgressBar,
  SignaturePad,
  useToast,
  type SignaturePadHandle,
} from '@hlonie/toolbox/ui';
import { api, humanError } from '../api/client';
import { QueryState } from '../components/query-state';
import { CheckIcon, ChevronRightIcon } from '@hlonie/toolbox/icons';
import { formatDate, status } from '../lib/format';
import { LinkButton } from '../components/link-button';
import { PAGE } from '../lib/layout';
import { useOpenDocument } from '../lib/open-document';

export interface InspectionState {
  id: string;
  kind: 'incoming' | 'outgoing';
  status: string;
  scheduledFor: string;
  leaseId: string;
  unit: string;
  reportKey: string | null;
  draftKey: string | null;
  draftSha256: string | null;
  viewer: { isLandlord: boolean; isTenant: boolean };
  signatures: { party: 'tenant' | 'landlord'; signedAt: string }[];
  /** Whether this viewer may reopen it, by the server's rules. */
  reopenable?: boolean;
  findings: {
    id: string;
    room: string;
    item: string;
    condition: string;
    note: string | null;
    photoKeys: string[];
  }[];
}

const FLAGGED = new Set(['poor', 'damaged', 'missing']);

export function InspectionRooms() {
  const { inspectionId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const openDocument = useOpenDocument();
  const queryClient = useQueryClient();
  const padRef = useRef<SignaturePadHandle>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<{ key: string; sha256: string } | null>(null);
  const [confirmReopen, setConfirmReopen] = useState(false);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['inspection', inspectionId],
    queryFn: () => api.get<InspectionState>(`/inspections/${inspectionId}`),
  });

  if (!data) {
    return <QueryState isLoading={isLoading} isError={isError} error={error} onRetry={refetch} what="This inspection" />;
  }

  const rooms = [...new Set(data.findings.map((finding) => finding.room))].map((room) => {
    const inRoom = data.findings.filter((finding) => finding.room === room);
    return {
      room,
      total: inRoom.length,
      flagged: inRoom.filter((finding) => FLAGGED.has(finding.condition)).length,
      noted: inRoom.filter((finding) => finding.condition !== 'good' || finding.note).length,
    };
  });

  const party: 'tenant' | 'landlord' = data.viewer.isLandlord ? 'landlord' : 'tenant';
  const signedParties = data.signatures.map((signature) => signature.party);
  const iHaveSigned = signedParties.includes(party);
  const walkthroughOpen = data.status === 'in_progress';
  // The draft rendered this session wins; on a revisit the stored one still counts.
  const reviewable = draft ?? (data.draftKey && data.draftSha256
    ? { key: data.draftKey, sha256: data.draftSha256 }
    : null);

  const prepare = async () => {
    setBusy(true);
    try {
      const rendered = await api.post<{ key: string; sha256: string }>(
        `/inspections/${inspectionId}/render`,
        {},
      );
      setDraft(rendered);
      toast.show({ title: 'Report ready', description: 'Read it, then sign below.', tone: 'success' });
    } catch (error) {
      toast.show({ title: 'Could not prepare the report', description: humanError(error), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  // Once someone has signed, the findings are locked. Reopening is how the other party disputes
  // them instead of signing what they disagree with; the server withdraws any signature given.
  // The server says who may: a tenant who missed the booked exit inspection may not.
  const canReopen = data.status !== 'missed' && (data.reopenable ?? (data.status === 'awaiting_signatures' && signedParties.length < 2));
  const reopen = async () => {
    setBusy(true);
    try {
      await api.post(`/inspections/${inspectionId}/reopen`, {});
      setConfirmReopen(false);
      setDraft(null);
      toast.show({ title: 'Reopened', description: 'Correct the findings, then prepare the report again.', tone: 'success' });
      queryClient.invalidateQueries({ queryKey: ['lease'] });
      refetch();
    } catch (error) {
      toast.show({ title: 'Not reopened', description: humanError(error), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const sign = async () => {
    if (padRef.current?.isEmpty()) {
      toast.show({ title: 'Signature missing', description: 'Sign above the line first.', tone: 'warning' });
      return;
    }
    setBusy(true);
    try {
      await api.post(`/inspections/${inspectionId}/signature`, {
        party,
        signatureBase64: padRef.current?.toDataUrl(),
        pdfSha256: reviewable!.sha256,
      });
      toast.show({ title: 'Signed', tone: 'success' });
      setDraft(null);
      // The lease page lists this inspection's status and report.
      queryClient.invalidateQueries({ queryKey: ['lease'] });
      refetch();
    } catch (error) {
      toast.show({ title: 'Not signed', description: humanError(error), tone: 'danger' });
      // 409: the findings changed, or the other party signed an earlier draft. The report has
      // to be prepared again before anyone can sign it, so drop the one on screen.
      if ((error as { status?: number }).status === 409) {
        setDraft(null);
        refetch();
      }
    } finally {
      setBusy(false);
    }
  };

  const missed = data.status === 'missed';
  const reportReady = Boolean(reviewable) || ['awaiting_signatures', 'completed'].includes(data.status);
  // Four steps: the walkthrough, the report, and a signature from each side.
  const stepsDone = data.status === 'completed' ? 4 : reportReady ? 2 + Math.min(signedParties.length, 1) : 0;
  const totalItems = data.findings.length;
  const totalFlagged = rooms.reduce((sum, room) => sum + room.flagged, 0);

  return (
    <main className={PAGE.wide}>
      <PageHeader
        title={data.kind === 'incoming' ? 'Move-in inspection' : 'Move-out inspection'}
        description={
          missed
            ? `${data.unit} · ${formatDate(data.scheduledFor)}`
            : `${data.unit} · ${formatDate(data.scheduledFor)}. Walk every room together, then both of you sign.`
        }
      />

      {/* A cancelled booking is a record, not a job: it explains itself and offers nothing to do. */}
      {missed ? (
        <Alert tone="warning" title="This inspection did not happen" className="mb-5">
          <p>
            It was booked for {formatDate(data.scheduledFor)} and then cancelled, because the notice was withdrawn or
            the inspection was booked again for another day. Nothing can be recorded or signed on it.
          </p>
          <LinkButton to={`/leases/${data.leaseId}`} size="sm" className="mt-3">Back to the lease</LinkButton>
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-4">
            <h2 className="text-lead font-bold text-ink">Rooms</h2>
            <p className="text-meta text-ink-muted">
              {rooms.length} room{rooms.length === 1 ? '' : 's'}, {totalItems} item{totalItems === 1 ? '' : 's'}
              {totalFlagged ? `, ${totalFlagged} need attention` : ''}
            </p>
          </div>
          <ul className="divide-y divide-line-soft border-t border-line-soft">
            {rooms.map((room) => (
              <li key={room.room}>
                <button
                  type="button"
                  className="flex w-full items-center gap-3.5 px-5 py-3.5 text-left hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--tb-ring)]"
                  onClick={() =>
                    navigate(`/inspections/${inspectionId}/room/${encodeURIComponent(room.room)}`)
                  }
                >
                  <span
                    aria-hidden
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 ${
                      room.noted ? 'border-brand-500 bg-brand-500 text-ink-inverse' : 'border-neutral-300 text-transparent'
                    }`}
                  >
                    <CheckIcon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-lead font-semibold text-ink">{room.room}</span>
                    <span className="block text-meta text-ink-muted">
                      {room.total} items{room.noted ? ` · ${room.noted} recorded` : ' · all marked good'}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    {room.flagged > 0 ? <Badge tone="warning">{room.flagged} flagged</Badge> : null}
                    <ChevronRightIcon className="shrink-0 text-ink-muted" aria-hidden />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>

        <div className="space-y-4">
          <Card>
            <div className="space-y-3 px-5 py-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lead font-bold text-ink">Progress</h2>
                <Badge tone={status(data.status).tone}>{data.status === 'in_progress' ? 'Walkthrough' : status(data.status).label}</Badge>
              </div>
              {missed ? null : <ProgressBar value={stepsDone} max={4} />}
              <ol className="space-y-2 text-body">
                <Step done={!missed && reportReady} label="Walk the rooms and record what you find" />
                <Step done={!missed && reportReady} label="Prepare the report" />
                <Step done={signedParties.includes('landlord')} label="The landlord signs" />
                <Step done={signedParties.includes('tenant')} label="The tenant signs" />
              </ol>
            </div>
          </Card>

          {data.status === 'completed' && data.reportKey ? (
            <>
              <Alert tone="success" title="Inspection complete">
                Both signatures are on the sealed report. It is part of the lease now.
              </Alert>
              <Button block size="lg" onClick={() => openDocument(data.reportKey!)}>
                Open the signed report
              </Button>
            </>
          ) : null}

          {data.status !== 'completed' && !missed ? (
            <Card>
              <CardBody className="space-y-3">
                <h2 className="text-lead font-bold text-ink">
                  Review and sign
                </h2>
                {walkthroughOpen && !reviewable ? (
                  <p className="text-body text-ink-muted">
                    When the walkthrough is done, prepare the report. Signing locks the findings.
                  </p>
                ) : null}

                {!reviewable ? (
                  <Button block size="lg" loading={busy} onClick={prepare}>
                    Prepare the report
                  </Button>
                ) : (
                  <>
                    <Button block variant="outline" onClick={() => openDocument(reviewable.key)}>
                      Open the report to review
                    </Button>
                    {iHaveSigned ? (
                      <Alert tone="info" title="Your signature is on file">
                        Waiting on the {party === 'tenant' ? 'landlord' : 'tenant'}.
                      </Alert>
                    ) : (
                      <>
                        <SignaturePad ref={padRef} />
                        <Button block size="lg" loading={busy} onClick={sign}>
                          Sign as the {party}
                        </Button>
                        <p className="text-meta text-ink-muted">
                          Your signature attests the exact report you just opened. If any finding
                          changes, the report is re-prepared and both of you sign again.
                        </p>
                      </>
                    )}
                    {walkthroughOpen && !iHaveSigned ? (
                      <Button block variant="ghost" loading={busy} onClick={prepare}>
                        Findings changed? Prepare it again
                      </Button>
                    ) : null}
                  </>
                )}
                {canReopen ? (
                  <Button block variant="outline" disabled={busy} onClick={() => setConfirmReopen(true)}>
                    Reopen to correct the findings
                  </Button>
                ) : null}
              </CardBody>
            </Card>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        open={confirmReopen}
        onOpenChange={(next) => !busy && setConfirmReopen(next)}
        title="Reopen the inspection?"
        description={
          signedParties.length
            ? `The findings can be changed again. ${signedParties[0] === party ? 'Your' : `The ${signedParties[0]}’s`} signature is withdrawn, and both of you sign the corrected report.`
            : 'The findings can be changed again, and both of you sign the corrected report.'
        }
        confirmLabel="Reopen it"
        loading={busy}
        onConfirm={reopen}
      />
    </main>
  );
}

function Step({ done, label }: { done: boolean; label: string }) {
  return (
    <li className="flex items-center gap-2.5">
      <span
        aria-hidden
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
          done ? 'border-brand-500 bg-brand-500 text-ink-inverse' : 'border-neutral-300 text-transparent'
        }`}
      >
        <CheckIcon className="h-3 w-3" />
      </span>
      <span className={done ? 'text-ink' : 'text-ink-muted'}>
        {label}
        <span className="sr-only">{done ? ', done' : ', still to do'}</span>
      </span>
    </li>
  );
}
