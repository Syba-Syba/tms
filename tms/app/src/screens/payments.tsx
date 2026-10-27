import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  Alert, Badge, Button, Card, CardBody, CurrencyInput, EmptyState, Modal, PageHeader, Select, Spinner, Tabs,
  Textarea, useToast,
} from '@hlonie/toolbox/ui';
import { formatZar } from '@hlonie/toolbox/utils';
import { api, humanError, openDocument } from '../api/client';
import { formatDate } from '../lib/format';

interface ProofRow {
  id: string;
  leaseId: string;
  leaseRef: string;
  tenant: string;
  unit: string;
  target: 'invoice' | 'deposit';
  period: string | null;
  amountCents: number;
  paidOn: string;
  reference: string | null;
  fileKey: string;
  owedCents: number;
}

interface ImportSummary {
  id: string;
  fileName: string;
  importedAt: string;
  lines: number;
  unmatched: number;
  matched: number;
}

interface ImportLine {
  id: string;
  postedOn: string;
  amountCents: number;
  description: string;
  status: 'unmatched' | 'matched' | 'ignored';
  leaseId: string | null;
  suggestion: { leaseId: string; confidence: 'high' | 'medium' | 'low'; reason: string } | null;
}

interface ImportDetail {
  id: string;
  fileName: string;
  leases: { leaseId: string; label: string; owedCents: number }[];
  lines: ImportLine[];
  summary?: { credits: number; added: number; alreadyImported: number; debitsSkipped: number };
}

const zar = (cents: number) => formatZar(cents / 100);
const confidenceTone = { high: 'success', medium: 'warning', low: 'neutral' } as const;

/** Money coming in that the landlord has not typed: tenants' slips and the bank statement. */
export function Payments() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <PageHeader title="Payments" description="Check tenants' slips and match your bank statement to leases." />
      <Tabs
        items={[
          { value: 'slips', label: 'Slips to check', content: <Slips /> },
          { value: 'bank', label: 'Bank import', content: <BankImport /> },
        ]}
      />
    </main>
  );
}

function Slips() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery({
    queryKey: ['payment-proofs'],
    queryFn: () => api.get<{ items: ProofRow[] }>('/payment-proofs'),
  });
  const [accepting, setAccepting] = useState<{ proof: ProofRow; cents: number | null } | null>(null);
  const [rejecting, setRejecting] = useState<{ proof: ProofRow; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const decide = async (proofId: string, body: Record<string, unknown>, done: string) => {
    setBusy(true);
    try {
      await api.post(`/payment-proofs/${proofId}/decision`, body);
      await queryClient.invalidateQueries({ queryKey: ['payment-proofs'] });
      await queryClient.invalidateQueries({ queryKey: ['leases'] });
      setAccepting(null);
      setRejecting(null);
      toast.show({ title: done, tone: 'success' });
    } catch (error) {
      toast.show({ title: 'Not saved', description: humanError(error), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  if (isLoading) return <Spinner />;
  if (!data?.items.length) {
    return <EmptyState title="No slips waiting" description="When a tenant sends proof of payment, it shows up here." />;
  }

  return (
    <div className="space-y-3">
      {data.items.map((proof) => (
        <Card key={proof.id}>
          <CardBody className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-[15px] font-semibold text-ink">{proof.tenant}</p>
                <p className="text-xs text-ink-muted">
                  <Link to={`/leases/${proof.leaseId}`} className="underline">{proof.unit}</Link>, {proof.leaseRef}
                </p>
              </div>
              <div className="text-right">
                <p className="font-mono text-[17px] font-semibold">{zar(proof.amountCents)}</p>
                <p className="text-xs text-ink-muted">paid {formatDate(proof.paidOn)}</p>
              </div>
            </div>
            <p className="text-xs text-ink-muted">
              {proof.target === 'deposit' ? 'For the deposit.' : proof.period ? `For rent ${proof.period}.` : 'For rent.'}{' '}
              Reference: {proof.reference ?? 'none given'}. The lease owes {zar(proof.owedCents)}.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => openDocument(proof.fileKey)}>View slip</Button>
              <Button onClick={() => setAccepting({ proof, cents: proof.amountCents })}>Accept</Button>
              <Button variant="ghost" onClick={() => setRejecting({ proof, reason: '' })}>Reject</Button>
            </div>
          </CardBody>
        </Card>
      ))}

      <Modal
        open={Boolean(accepting)}
        onOpenChange={(open) => !open && setAccepting(null)}
        title="Accept this slip"
        description="Only accept once the money shows in your account. Change the amount if less arrived."
      >
        {accepting ? (
          <div className="space-y-3">
            <CurrencyInput
              cents={accepting.cents}
              onCentsChange={(cents) => setAccepting({ ...accepting, cents })}
              aria-label="Amount received"
            />
            <p className="text-xs text-ink-muted">
              It is recorded against the oldest unpaid rent first. More than the lease owes is refused.
            </p>
            <Button
              block
              loading={busy}
              disabled={!accepting.cents}
              onClick={() =>
                decide(accepting.proof.id, { decision: 'accept', amountCents: accepting.cents }, 'Payment recorded')
              }
            >
              Record {zar(accepting.cents ?? 0)}
            </Button>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(rejecting)}
        onOpenChange={(open) => !open && setRejecting(null)}
        title="Reject this slip"
        description="The tenant sees your reason, so say what they need to fix."
      >
        {rejecting ? (
          <div className="space-y-3">
            <Textarea
              placeholder="For example: nothing has arrived in the account yet."
              maxLength={300}
              value={rejecting.reason}
              onChange={(event) => setRejecting({ ...rejecting, reason: event.target.value })}
            />
            <Button
              block
              variant="danger"
              loading={busy}
              disabled={rejecting.reason.trim().length < 3}
              onClick={() =>
                decide(rejecting.proof.id, { decision: 'reject', reason: rejecting.reason.trim() }, 'Slip rejected')
              }
            >
              Reject and tell the tenant
            </Button>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

function BankImport() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [openId, setOpenId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [summary, setSummary] = useState<ImportDetail['summary'] | null>(null);
  const history = useQuery({
    queryKey: ['bank-imports'],
    queryFn: () => api.get<{ items: ImportSummary[] }>('/bank-imports'),
  });

  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 900_000) {
      toast.show({ title: 'File too large', description: 'Export a shorter date range.', tone: 'danger' });
      return;
    }
    setUploading(true);
    try {
      const detail = await api.post<ImportDetail>('/bank-imports', { fileName: file.name, content: await file.text() });
      queryClient.setQueryData(['bank-import', detail.id], detail);
      await queryClient.invalidateQueries({ queryKey: ['bank-imports'] });
      setSummary(detail.summary ?? null);
      setOpenId(detail.id);
    } catch (error) {
      toast.show({ title: 'Statement not imported', description: humanError(error), tone: 'danger' });
    } finally {
      setUploading(false);
    }
  };

  if (openId) {
    return (
      <ImportReview
        importId={openId}
        summary={summary}
        onBack={() => {
          setOpenId(null);
          setSummary(null);
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="space-y-3">
          <p className="text-[14px] text-ink">
            Download your statement from internet banking as <b>OFX</b> (best) or <b>CSV</b>, then upload it here.
            Only money coming in is read. Lines you already imported are skipped.
          </p>
          <label className="block">
            <span className="sr-only">Statement file</span>
            <input
              type="file"
              accept=".csv,.ofx,.qfx,text/csv"
              disabled={uploading}
              onChange={(event) => {
                void upload(event.target.files?.[0]);
                event.target.value = '';
              }}
              className="block w-full text-sm text-ink-muted file:mr-3 file:rounded-sm file:border-0 file:bg-brand-50 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-brand-500"
            />
          </label>
          {uploading ? <Spinner /> : null}
        </CardBody>
      </Card>

      {history.data?.items.length ? (
        <div className="space-y-2">
          <h2 className="text-xs font-bold uppercase tracking-widest text-ink-muted">Earlier imports</h2>
          {history.data.items.map((item) => (
            <Card key={item.id}>
              <CardBody className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[14px] font-semibold">{item.fileName}</p>
                  <p className="text-xs text-ink-muted">
                    {formatDate(item.importedAt)}, {item.lines} credits, {item.matched} matched
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {item.unmatched > 0 ? <Badge tone="warning">{item.unmatched} to review</Badge> : <Badge tone="success">done</Badge>}
                  <Button variant="outline" onClick={() => setOpenId(item.id)}>Open</Button>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ImportReview({
  importId,
  summary,
  onBack,
}: {
  importId: string;
  summary: ImportDetail['summary'] | null;
  onBack: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({
    queryKey: ['bank-import', importId],
    queryFn: () => api.get<ImportDetail>(`/bank-imports/${importId}`),
  });
  // What the landlord picked per line. Starts from the suggestion; '' means leave it for now.
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  if (!data) return <Spinner />;
  const unmatched = data.lines.filter((line) => line.status === 'unmatched');
  const picked = (line: ImportLine) => choice[line.id] ?? line.suggestion?.leaseId ?? '';
  const ready = unmatched.filter((line) => picked(line));

  const resolve = async (lines: Array<{ lineId: string; leaseId?: string; ignore?: true }>) => {
    setBusy(true);
    try {
      const result = await api.post<{ results: { lineId: string; ok: boolean; error?: string }[]; import: ImportDetail }>(
        `/bank-imports/${importId}/resolve`,
        { lines },
      );
      queryClient.setQueryData(['bank-import', importId], result.import);
      await queryClient.invalidateQueries({ queryKey: ['bank-imports'] });
      await queryClient.invalidateQueries({ queryKey: ['payment-proofs'] });
      await queryClient.invalidateQueries({ queryKey: ['leases'] });
      const failed = result.results.filter((item) => !item.ok);
      toast.show(
        failed.length
          ? { title: `${failed.length} not recorded`, description: failed[0]!.error, tone: 'warning' }
          : { title: 'Saved', tone: 'success' },
      );
    } catch (error) {
      toast.show({ title: 'Not saved', description: humanError(error), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const leaseOptions = [
    { value: '', label: 'Pick a lease' },
    ...data.leases.map((lease) => ({ value: lease.leaseId, label: `${lease.label}, owes ${zar(lease.owedCents)}` })),
  ];
  const leaseLabel = (leaseId: string | null) => data.leases.find((lease) => lease.leaseId === leaseId)?.label ?? 'a lease';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" onClick={onBack}>Back</Button>
        <p className="truncate text-xs text-ink-muted">{data.fileName}</p>
      </div>
      {summary ? (
        <Alert tone="info" title={summary.added === 1 ? '1 new credit read' : `${summary.added} new credits read`}>
          {summary.alreadyImported > 0 ? `${summary.alreadyImported} were already imported and skipped. ` : ''}
          {summary.debitsSkipped === 1 ? '1 payment out was ignored.' : `${summary.debitsSkipped} payments out were ignored.`}
        </Alert>
      ) : null}

      {unmatched.length === 0 ? (
        <EmptyState title="Nothing left to match" description="Every credit in this statement is recorded or set aside." />
      ) : (
        <>
          <p className="text-[13px] text-ink-muted">
            Check each suggestion before you confirm. Confirming records the payment and tells the tenant.
          </p>
          {unmatched.map((line) => (
            <Card key={line.id}>
              <CardBody className="space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="break-words text-[14px] font-semibold text-ink">{line.description}</p>
                    <p className="text-xs text-ink-muted">{formatDate(line.postedOn)}</p>
                  </div>
                  <p className="whitespace-nowrap font-mono text-[15px] font-semibold">{zar(line.amountCents)}</p>
                </div>
                {line.suggestion ? (
                  <p className="flex items-center gap-2 text-xs text-ink-muted">
                    <Badge tone={confidenceTone[line.suggestion.confidence]}>{line.suggestion.confidence}</Badge>
                    {line.suggestion.reason}
                  </p>
                ) : (
                  <p className="text-xs text-ink-muted">No match found. Pick the lease, or set it aside.</p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Select
                    className="min-w-0 flex-1"
                    aria-label="Lease"
                    value={picked(line)}
                    onChange={(event) => setChoice({ ...choice, [line.id]: event.target.value })}
                    options={leaseOptions}
                  />
                  <Button
                    variant="outline"
                    disabled={busy || !picked(line)}
                    onClick={() => resolve([{ lineId: line.id, leaseId: picked(line) }])}
                  >
                    Confirm
                  </Button>
                  <Button variant="ghost" disabled={busy} onClick={() => resolve([{ lineId: line.id, ignore: true }])}>
                    Not rent
                  </Button>
                </div>
              </CardBody>
            </Card>
          ))}
          <Button
            block
            loading={busy}
            disabled={ready.length === 0}
            onClick={() => resolve(ready.map((line) => ({ lineId: line.id, leaseId: picked(line) })))}
          >
            Confirm {ready.length} matched {ready.length === 1 ? 'line' : 'lines'}
          </Button>
        </>
      )}

      {data.lines.some((line) => line.status !== 'unmatched') ? (
        <div className="space-y-1 pt-2">
          <h2 className="text-xs font-bold uppercase tracking-widest text-ink-muted">Done</h2>
          {data.lines
            .filter((line) => line.status !== 'unmatched')
            .map((line) => (
              <p key={line.id} className="flex justify-between gap-3 text-xs text-ink-muted">
                <span className="truncate">
                  {formatDate(line.postedOn)} {line.description}
                </span>
                <span className="whitespace-nowrap">
                  {zar(line.amountCents)} {line.status === 'matched' ? `to ${leaseLabel(line.leaseId)}` : 'set aside'}
                </span>
              </p>
            ))}
        </div>
      ) : null}
    </div>
  );
}
