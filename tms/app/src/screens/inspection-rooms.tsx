import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  PageHeader,
  SignaturePad,
  useToast,
  type SignaturePadHandle,
} from '@hlonie/toolbox/ui';
import { api, humanError } from '../api/client';
import { QueryState } from '../components/query-state';
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

  return (
    <main className="mx-auto max-w-lg px-4 py-6">
      <PageHeader
        title={data.kind === 'incoming' ? 'Move-in inspection' : 'Move-out inspection'}
        description={`${data.unit} · ${data.scheduledFor}. Walk every room together, then both of you sign.`}
      />

      <div className="space-y-3">
        {rooms.map((room) => (
          <Card key={room.room}>
            <button
              type="button"
              className="flex w-full items-center justify-between px-5 py-4 text-left"
              onClick={() =>
                navigate(`/inspections/${inspectionId}/room/${encodeURIComponent(room.room)}`)
              }
            >
              <div>
                <p className="text-[15px] font-semibold text-ink">{room.room}</p>
                <p className="text-xs text-ink-muted">
                  {room.total} items{room.noted ? ` · ${room.noted} recorded` : ''}
                </p>
              </div>
              <span className="flex items-center gap-2">
                {room.flagged > 0 ? <Badge tone="warning">{room.flagged} flagged</Badge> : null}
                <span className="text-ink-muted">›</span>
              </span>
            </button>
          </Card>
        ))}
      </div>

      <div className="mt-5 space-y-3">
        {data.status === 'completed' && data.reportKey ? (
          <>
            <Alert tone="success" title="Inspection complete">
              Both signatures are on the sealed report. It is part of the lease now.
            </Alert>
            <Button block variant="outline" onClick={() => openDocument(data.reportKey!)}>
              Open the signed report
            </Button>
          </>
        ) : null}

        {data.status !== 'completed' ? (
          <Card>
            <CardBody className="space-y-3">
              <p className="text-[10.5px] font-bold uppercase tracking-widest text-ink-muted">
                Review and sign
              </p>
              {walkthroughOpen && !reviewable ? (
                <p className="text-[13.5px] text-ink-muted">
                  When the walkthrough is done, prepare the report. Signing locks the findings.
                </p>
              ) : null}

              {!reviewable ? (
                <Button block loading={busy} onClick={prepare}>
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
                      <Button block loading={busy} onClick={sign}>
                        Sign as the {party}
                      </Button>
                      <p className="text-xs text-ink-muted">
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
            </CardBody>
          </Card>
        ) : null}
      </div>
    </main>
  );
}
