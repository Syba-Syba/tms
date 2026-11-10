import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  Alert, Avatar, Badge, Button, Card, CardBody, CurrencyInput, EmptyState, Modal, PageHeader, Select, Spinner,
  Textarea, useToast,
} from '@hlonie/toolbox/ui';
import { formatZar } from '@hlonie/toolbox/utils';
import { api, humanError } from '../api/client';
import { useOpenDocument } from '../lib/open-document';
import { QueryError } from '../components/query-state';
import { formatDate, formatInstant, formatMonth, headlineZar } from '../lib/format';
import { localToday as today } from '../lib/dates';
import { invalidateMoneyCaches } from '../lib/money-caches';
import { PAGE } from '../lib/layout';
import { Money } from '../components/money';
import { ListsSteps, ListsTabs, ListsTile, ListsTiles, ListsUploadArea } from '../components/lists-kit';

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
const confidenceLabel = { high: 'Strong match', medium: 'Likely match', low: 'Weak guess' } as const;

interface ArrearsRow {
  leaseId?: string;
  tenant?: string;
  unit?: string;
  totalCents: number;
  ageing?: { current: number };
}

/** Money coming in that the landlord has not typed: tenants' slips and the bank statement. */
export function Payments() {
  const [tab, setTab] = useState<'slips' | 'bank'>('slips');
  const monthStart = `${today().slice(0, 7)}-01`;
  const month = useQuery({
    queryKey: ['report-income', monthStart, today()],
    queryFn: () =>
      api.get<{ totals: { invoicedCents: number; collectedCents: number } }>(
        `/reports/income-expense?from=${monthStart}&to=${today()}`,
      ),
  });
  const arrears = useQuery({
    queryKey: ['report-arrears'],
    queryFn: () => api.get<{ items: ArrearsRow[]; totals: { totalCents: number } }>('/reports/arrears'),
  });
  const proofs = useQuery({
    queryKey: ['payment-proofs'],
    queryFn: () => api.get<{ items: ProofRow[] }>('/payment-proofs'),
  });

  // 'current' is rent not yet late: next month's, issued on the 25th. Only the rest is behind.
  const behind = (arrears.data?.items ?? [])
    .map((item) => ({ ...item, lateCents: item.totalCents - (item.ageing?.current ?? 0) }))
    .filter((item) => item.lateCents > 0);
  const lateCents = behind.reduce((sum, item) => sum + item.lateCents, 0);
  const notDueCents = (arrears.data?.totals.totalCents ?? 0) - lateCents;
  const slipCount = proofs.data?.items.length;
  const monthName = formatMonth(today()).split(' ')[0];

  return (
    <main className={PAGE.wide}>
      <PageHeader title="Payments" description="Check tenants' slips and match your bank statement to leases." />

      <ListsTiles columns={3}>
        <ListsTile
          label={`Collected in ${monthName}`}
          value={month.data ? <Money whole cents={month.data.totals.collectedCents} /> : '–'}
          note={month.data ? `of ${headlineZar(month.data.totals.invoicedCents)} invoiced` : month.isError ? 'Not available right now' : 'Loading'}
        />
        <ListsTile
          tone={lateCents > 0 ? 'danger' : 'plain'}
          label="Overdue from tenants"
          value={arrears.data ? <Money whole cents={lateCents} /> : '–'}
          note={
            !arrears.data
              ? arrears.isError ? 'Not available right now' : 'Loading'
              : behind.length === 0
                ? notDueCents > 0 ? `Nobody is behind. ${headlineZar(notDueCents)} not yet due` : 'Nobody is behind'
                : `${behind.length} lease${behind.length === 1 ? '' : 's'} behind${notDueCents > 0 ? `, ${headlineZar(notDueCents)} more not yet due` : ''}`
          }
        />
        <div className="col-span-2 lg:col-span-1">
          <ListsTile
            label="Slips to check"
            value={slipCount ?? '–'}
            note={slipCount === undefined ? (proofs.isError ? 'Not available right now' : 'Loading') : slipCount === 0 ? 'Nothing waiting on you' : 'Sent by tenants, waiting on you'}
          />
        </div>
      </ListsTiles>

      <ListsTabs
        className="mb-5"
        label="Payments"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'slips', label: 'Slips to check', count: slipCount, tone: 'danger' },
          { value: 'bank', label: 'Bank import' },
        ]}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div role="tabpanel" aria-label={tab === 'slips' ? 'Slips to check' : 'Bank import'} className="min-w-0">
          {tab === 'slips' ? <Slips onOpenBank={() => setTab('bank')} /> : <BankImport />}
        </div>

        <aside className="space-y-5">
          <Card>
            <div className="flex items-center justify-between gap-3 border-b border-line-soft px-5 py-4">
              <h2 className="text-lead font-bold text-ink">Behind on rent</h2>
              <Link to="/reports" className="inline-flex min-h-6 items-center text-meta font-semibold text-brand-500 hover:underline">
                Arrears by lease
              </Link>
            </div>
            {behind.length === 0 ? (
              <p className="px-5 py-4 text-body text-ink-muted">
                {arrears.data ? 'Nobody is behind. Leases with overdue rent show here.' : arrears.isError ? 'Not available right now.' : 'Loading…'}
              </p>
            ) : (
              <ul className="divide-y divide-line-soft">
                {behind.slice(0, 6).map((item, index) => (
                  <li key={item.leaseId ?? index}>
                    <Link to={item.leaseId ? `/leases/${item.leaseId}` : '/reports'} className="flex items-center gap-3 px-5 py-3.5 hover:bg-surface-muted">
                      <Avatar name={item.tenant ?? 'Tenant'} tone="danger" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body font-semibold text-ink">{item.tenant ?? 'Tenant'}</span>
                        <span className="block text-meta text-ink-muted">{item.unit ?? ''}</span>
                        <Badge tone="danger" className="mt-1.5">Owes {headlineZar(item.lateCents)}</Badge>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardBody className="space-y-4">
              <h2 className="text-lead font-bold text-ink">How matching works</h2>
              <ListsSteps
                steps={[
                  { title: 'A tenant sends a slip', detail: 'Accept it once the money shows in your account. Reject it with a reason if it has not.' },
                  { title: 'Or upload your bank statement', detail: 'Each credit is matched to a lease by its reference, then by amount.' },
                  { title: 'You confirm', detail: 'The payment goes against the oldest unpaid rent first and the tenant is told.' },
                ]}
              />
            </CardBody>
          </Card>
        </aside>
      </div>
    </main>
  );
}

function Slips({ onOpenBank }: { onOpenBank: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const openDocument = useOpenDocument();
  const { data, isLoading, isError, error, refetch } = useQuery({
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
      // An accepted slip records a payment: lease, arrears, statement and reports all move.
      await invalidateMoneyCaches(queryClient);
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
  if (isError) return <QueryError error={error} onRetry={() => void refetch()} what="The slips" />;
  if (!data?.items.length) {
    return (
      <EmptyState
        title="No slips waiting"
        description="When a tenant sends proof of payment it shows up here for you to accept or reject. Paid by EFT without a slip? Upload your bank statement and match it to the lease."
        action={<Button onClick={onOpenBank}>Upload a bank statement</Button>}
      />
    );
  }

  return (
    <div className="space-y-4">
      {data.items.map((proof) => (
        <Card key={proof.id}>
          <CardBody className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <Avatar name={proof.tenant} size="lg" />
                <div className="min-w-0">
                  <p className="truncate text-lead font-bold text-ink">{proof.tenant}</p>
                  <p className="text-meta text-ink-muted">
                    <Link to={`/leases/${proof.leaseId}`} className="font-semibold text-brand-500 hover:underline">{proof.unit}</Link>, {proof.leaseRef}
                  </p>
                </div>
              </div>
              <div className="sm:text-right">
                <p className="text-figure text-ink"><Money cents={proof.amountCents} /></p>
                <p className="text-meta text-ink-muted">paid {formatDate(proof.paidOn)}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="info">
                {proof.target === 'deposit' ? 'Deposit' : proof.period ? `Rent for ${formatMonth(proof.period)}` : 'Rent'}
              </Badge>
              <Badge tone="neutral">Reference: {proof.reference ?? 'none given'}</Badge>
              <Badge tone={proof.owedCents > 0 ? 'warning' : 'neutral'}>Lease owes {zar(proof.owedCents)}</Badge>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line-soft pt-4">
              <Button variant="secondary" onClick={() => openDocument(proof.fileKey)}>View slip</Button>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setRejecting({ proof, reason: '' })}>Reject</Button>
                <Button onClick={() => setAccepting({ proof, cents: proof.amountCents })}>Accept</Button>
              </div>
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
              aria-label="Reason for rejecting"
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
    <div className="space-y-5">
      <Card>
        <CardBody className="space-y-4">
          <div>
            <h2 className="text-lead font-bold text-ink">Upload your bank statement</h2>
            <p className="mt-1 text-body text-ink-muted">
              Download it from internet banking as <b className="text-ink">OFX</b> (best) or <b className="text-ink">CSV</b>.
              Only money coming in is read. Lines you already imported are skipped.
            </p>
          </div>
          <ListsUploadArea
            label="Statement file"
            title="Choose your statement"
            hint="OFX, QFX or CSV, up to about 900 KB. For a bigger file, export a shorter date range."
            accept=".csv,.ofx,.qfx,text/csv"
            disabled={uploading}
            busy={uploading}
            onFile={(file) => void upload(file)}
          />
        </CardBody>
      </Card>

      {history.isError ? (
        <QueryError error={history.error} onRetry={() => void history.refetch()} what="Earlier imports" />
      ) : null}
      {history.data?.items.length ? (
        <Card>
          <h2 className="border-b border-line-soft px-5 py-4 text-lead font-bold text-ink">Earlier imports</h2>
          <ul className="divide-y divide-line-soft">
            {history.data.items.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                <div className="min-w-0">
                  <p className="truncate text-body font-semibold text-ink">{item.fileName}</p>
                  <p className="text-meta text-ink-muted">
                    {formatInstant(item.importedAt)}, {item.lines} credit{item.lines === 1 ? '' : 's'}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="success">{item.matched} matched</Badge>
                  {item.unmatched > 0 ? <Badge tone="warning">{item.unmatched} to review</Badge> : <Badge tone="neutral">Done</Badge>}
                  <Button size="sm" variant="outline" onClick={() => setOpenId(item.id)}>Open</Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
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
  const { data, isError, error, refetch } = useQuery({
    queryKey: ['bank-import', importId],
    queryFn: () => api.get<ImportDetail>(`/bank-imports/${importId}`),
  });
  // What the landlord picked per line. Starts from the suggestion; '' means leave it for now.
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  if (isError) return <QueryError error={error} onRetry={() => void refetch()} what="The import" />;
  if (!data) return <Spinner />;
  const unmatched = data.lines.filter((line) => line.status === 'unmatched');
  const picked = (line: ImportLine) => choice[line.id] ?? line.suggestion?.leaseId ?? '';
  // The bulk confirm takes only lines the landlord picked or the matcher is sure of. A weak
  // guess (an amount-only match) stays preselected for its own Confirm, checked one by one.
  const ready = unmatched.filter((line) =>
    choice[line.id] !== undefined ? Boolean(choice[line.id]) : line.suggestion?.confidence === 'high' && Boolean(line.suggestion.leaseId),
  );

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
      // A matched line records a payment: lease, arrears, statement and reports all move.
      await invalidateMoneyCaches(queryClient);
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button size="sm" variant="outline" onClick={onBack}>Back</Button>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p className="truncate text-meta font-semibold text-ink">{data.fileName}</p>
          <Badge tone="success">{data.lines.filter((line) => line.status === 'matched').length} matched</Badge>
          <Badge tone={unmatched.length > 0 ? 'warning' : 'neutral'}>{unmatched.length} unmatched</Badge>
        </div>
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
          <p className="text-body text-ink-muted">
            Check each suggestion before you confirm. Confirming records the payment and tells the tenant.
          </p>
          {unmatched.map((line) => (
            <Card key={line.id}>
              <CardBody className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="break-words text-body font-semibold text-ink">{line.description}</p>
                    <p className="text-meta text-ink-muted">{formatDate(line.postedOn)}</p>
                  </div>
                  <p className="whitespace-nowrap text-title text-ink"><Money cents={line.amountCents} /></p>
                </div>
                {line.suggestion ? (
                  <p className="flex flex-wrap items-center gap-2 text-meta text-ink-muted">
                    <Badge tone={confidenceTone[line.suggestion.confidence]}>{confidenceLabel[line.suggestion.confidence]}</Badge>
                    {line.suggestion.reason}
                  </p>
                ) : (
                  <p className="flex flex-wrap items-center gap-2 text-meta text-ink-muted">
                    <Badge tone="neutral">No match</Badge>
                    Pick the lease, or set it aside.
                  </p>
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
                    variant="secondary"
                    disabled={busy || !picked(line)}
                    onClick={() => resolve([{ lineId: line.id, leaseId: picked(line) }])}
                  >
                    Confirm
                  </Button>
                  <Button variant="outline" disabled={busy} onClick={() => resolve([{ lineId: line.id, ignore: true }])}>
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
        <Card>
          <h2 className="border-b border-line-soft px-5 py-4 text-lead font-bold text-ink">Done</h2>
          <ul className="divide-y divide-line-soft">
            {data.lines
              .filter((line) => line.status !== 'unmatched')
              .map((line) => (
                <li key={line.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-5 py-3.5">
                  <span className="min-w-0">
                    <span className="block truncate text-body text-ink">{line.description}</span>
                    <span className="block text-meta text-ink-muted">{formatDate(line.postedOn)} · {zar(line.amountCents)}</span>
                  </span>
                  {line.status === 'matched'
                    ? <Badge tone="success">Matched to {leaseLabel(line.leaseId)}</Badge>
                    : <Badge tone="neutral">Set aside</Badge>}
                </li>
              ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
