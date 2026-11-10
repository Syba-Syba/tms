import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router';
import {
  Alert, Badge, Button, Card, CardBody, CurrencyInput, Input, Modal, PageHeader, Select, useToast,
} from '@hlonie/toolbox/ui';
import { useCopyToClipboard } from '@hlonie/toolbox/hooks';
import { formatZar } from '@hlonie/toolbox/utils';
import { api, humanError } from '../api/client';
import { formatDate, formatMonth, status } from '../lib/format';
import { localToday } from '../lib/dates';
import { csvText } from '../lib/csv';
import { QueryState } from '../components/query-state';
import { invalidateMoneyCaches } from '../lib/money-caches';
import { ArrearsPanel } from '../components/arrears-panel';
import { Money } from '../components/money';
import { useOpenDocument } from '../lib/open-document';
import { PAGE } from '../lib/layout';

interface Proof {
  id: string;
  target: 'invoice' | 'deposit';
  invoiceId: string | null;
  amountCents: number;
  paidOn: string;
  reference: string | null;
  status: 'pending' | 'accepted' | 'rejected';
  rejectReason: string | null;
}

interface Statement {
  reference: string | null;
  landlord: string | null;
  bank: { name: string; holder: string; accountNumber: string; branchCode: string } | null;
  bankChangedOn: string | null;
  landlordPhone: string | null;
  balanceCents: number;
  depositBalanceCents: number;
  invoices: { id: string; period: string; dueOn: string; totalCents: number; status: string }[];
  /** A deposit asked for and not yet received. Owed like rent, and not part of balanceCents. */
  depositOwingCents?: number;
  payments: {
    id: string; amountCents: number; receivedOn: string; reference: string | null;
    /** 'reversal' for the entry that undoes an earlier payment. */
    method?: string;
    /** On a payment that was reversed: the id of the entry that undid it. */
    reversedBy?: string | null;
    /** On a reversal: the payment it undoes. */
    reversesPaymentId?: string | null;
    reason?: string | null;
  }[];
  proofs: Proof[];
}

const proofTone = { pending: 'info', accepted: 'success', rejected: 'danger' } as const;
const proofLabel = { pending: 'Waiting for landlord', accepted: 'Accepted', rejected: 'Not accepted' } as const;

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];
const MAX_BYTES = 10 * 1024 * 1024;
// The device's calendar (SAST for our users), not UTC: before 02:00 UTC was still yesterday.
const today = localToday;

/** There is no server-rendered PDF for a running statement, only for the exit statement, so
    the download is built from the same rows the screen is already showing. CSV, because the
    thing a tenant does with this is hand it to a bank or paste it into a dispute. */
function statementCsv(statement: Statement): string {
  const rows: (string | number)[][] = [['Date', 'Description', 'Reference', 'Debit', 'Credit']];
  for (const invoice of statement.invoices) {
    rows.push([invoice.dueOn, `Rent ${formatMonth(invoice.period)}`, '', (invoice.totalCents / 100).toFixed(2), '']);
  }
  for (const payment of statement.payments) {
    rows.push([payment.receivedOn, 'Payment received', payment.reference ?? '', '', (payment.amountCents / 100).toFixed(2)]);
  }
  rows.push([]);
  rows.push(['', 'Balance outstanding', '', (statement.balanceCents / 100).toFixed(2), '']);
  rows.push(['', 'Deposit held', '', '', (statement.depositBalanceCents / 100).toFixed(2)]);
  return csvText(rows);
}

// A function, not a constant: computed at module load, paidOn stayed on the day the app was
// opened, so a tab left open overnight offered yesterday as the payment date.
const blankSlip = () => ({ invoiceId: '', amountCents: null as number | null, paidOn: today(), reference: '' });
type Slip = ReturnType<typeof blankSlip>;
const untouched = (slip: Slip) => !slip.invoiceId && slip.amountCents === null && !slip.reference;

/**
 * The invoices a waiting slip is for. A rent slip names its invoice, or none for "oldest month
 * first", which could be any unpaid one. A deposit slip has no invoice either, and used to be
 * read the same way, so one waiting deposit slip marked every unpaid month "Proof sent".
 */
export function invoicesWithPendingProof(
  proofs: { target: 'invoice' | 'deposit'; invoiceId: string | null; status: string }[],
  invoices: { id: string; status: string }[],
): Set<string> {
  const marked = new Set<string>();
  for (const proof of proofs) {
    if (proof.status !== 'pending' || proof.target === 'deposit') continue;
    for (const invoice of invoices) {
      if (invoice.status === 'paid') continue;
      if (proof.invoiceId === null || proof.invoiceId === invoice.id) marked.add(invoice.id);
    }
  }
  return marked;
}

export function TenantRent() {
  const { leaseId } = useParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['statement', leaseId],
    queryFn: () => api.get<Statement>(`/leases/${leaseId}/statement`),
  });

  // A deposit not yet received is owed too, and the statement's balance (invoices less
  // payments) leaves it out, so this page said "fully paid up" beside a deposit still due.
  const { data: leases } = useQuery({
    queryKey: ['leases', 'with-ended'],
    queryFn: () => api.get<{ items: { id: string; depositOwingCents?: number }[] }>('/leases', { query: { include: 'ended' } }),
    retry: false,
    // The statement says it itself now; the lease list is only asked when it does not.
    enabled: data !== undefined && data.depositOwingCents === undefined,
  });
  const depositOwing = data?.depositOwingCents ?? leases?.items.find((item) => item.id === leaseId)?.depositOwingCents ?? 0;
  const openDocument = useOpenDocument();

  // The home screen's "Send proof of payment" lands here with the form already open.
  const [params] = useSearchParams();
  const [showSlip, setShowSlip] = useState(() => params.get('proof') === '1');
  const [slip, setSlip] = useState(blankSlip);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const balance = data?.balanceCents ?? 0;
  const open = data?.invoices.filter((invoice) => invoice.status === 'issued' || invoice.status === 'part_paid') ?? [];
  const proofSentFor = invoicesWithPendingProof(data?.proofs ?? [], data?.invoices ?? []);

  const fileProblem = !file
    ? null
    : !ACCEPTED_TYPES.includes(file.type)
      ? 'Send a photo (JPG or PNG) or a PDF.'
      : file.size > MAX_BYTES
        ? 'That file is over 10 MB.'
        : null;
  const ready = Boolean(file) && !fileProblem && (slip.amountCents ?? 0) > 0 && Boolean(slip.paidOn);

  const download = () => {
    if (!data) return;
    const url = URL.createObjectURL(new Blob([statementCsv(data)], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `statement-${data.reference ?? leaseId}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  /** Three calls: say what was paid, upload the file to the signed link, then send it. */
  const sendSlip = async () => {
    if (!file || !slip.amountCents) return;
    setBusy(true);
    try {
      const isDeposit = slip.invoiceId === 'deposit';
      const created = await api.post<{ proofId: string; uploadUrl: string }>(`/leases/${leaseId}/payment-proofs`, {
        target: isDeposit ? 'deposit' : 'invoice',
        invoiceId: isDeposit || !slip.invoiceId ? undefined : slip.invoiceId,
        amountCents: slip.amountCents,
        paidOn: slip.paidOn,
        reference: slip.reference || undefined,
        contentType: file.type,
        sizeBytes: file.size,
      });
      const uploaded = await fetch(created.uploadUrl, {
        method: 'PUT',
        body: file,
        headers: { 'content-type': file.type },
      });
      if (!uploaded.ok) throw new Error('The upload did not go through. Try again.');
      await api.post(`/payment-proofs/${created.proofId}/submit`, {});
      // The arrears panel reads its own query; a slip can pause the arrears process.
      await invalidateMoneyCaches(queryClient);
      setShowSlip(false);
      setSlip(blankSlip());
      setFile(null);
      toast.show({ title: 'Proof sent', description: 'Your landlord checks it against their account.', tone: 'success' });
    } catch (error) {
      toast.show({
        title: 'Proof not sent',
        description: error instanceof Error && !('status' in error) ? error.message : humanError(error),
        tone: 'danger',
      });
    } finally {
      setBusy(false);
    }
  };

  if (!data) {
    return <QueryState isLoading={isLoading} isError={isError} error={error} onRetry={refetch} what="Your statement" />;
  }

  const outstanding = Math.max(balance, 0) + depositOwing;
  // A reversal is an entry of its own on the statement. Here it is shown on the payment it
  // undoes, struck through with the reason, rather than as a second, negative line.
  const received = data.payments.filter((payment) => payment.method !== 'reversal' && !payment.reversesPaymentId);
  const reversalOf = (payment: Statement['payments'][number]) =>
    data.payments.find((entry) => entry.reversesPaymentId === payment.id || (payment.reversedBy && entry.id === payment.reversedBy));
  const standing = received.filter((payment) => !payment.reversedBy && !reversalOf(payment));
  const overdue = open.some((invoice) => invoice.dueOn < today());
  const openSlip = () => {
    // Fresh date each time it opens, unless they left a half-filled slip to come back to.
    setSlip((current) => (untouched(current) ? blankSlip() : current));
    setShowSlip(true);
  };

  return (
    <main className={PAGE.wide}>
      <PageHeader
        title="Rent"
        description={
          outstanding <= 0
            ? 'You are fully paid up.'
            : depositOwing > 0
              ? `${formatZar(outstanding / 100)} outstanding, including your deposit of ${formatZar(depositOwing / 100)}.`
              : `${formatZar(outstanding / 100)} outstanding.`
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className={`col-span-2 rounded-md border px-5 py-4 ${
          outstanding <= 0 ? 'border-success/30 bg-tint-success' : overdue ? 'border-danger/30 bg-tint-danger' : 'border-warning/30 bg-tint-warning'
        }`}>
          <p className="text-meta font-semibold text-ink">{outstanding <= 0 ? 'Where you stand' : overdue ? 'Overdue' : 'To pay'}</p>
          {outstanding <= 0 ? (
            <p className="mt-1 text-figure font-bold text-ink">Paid up</p>
          ) : (
            <p className="mt-1"><Money cents={outstanding} className={`text-figure ${overdue ? 'text-danger' : 'text-ink'}`} /></p>
          )}
          <p className="text-meta text-ink">
            {outstanding <= 0
              ? 'Nothing is owing on your rent or deposit.'
              : depositOwing > 0 && balance > 0
                ? <>Rent <Money cents={balance} /> and deposit <Money cents={depositOwing} /></>
                : depositOwing > 0
                  ? 'Your deposit, due within 7 days of signing'
                  : open[0]
                    ? `${formatMonth(open[0].period)}, due ${formatDate(open[0].dueOn)}`
                    : 'Rent and charges'}
          </p>
        </div>
        <Card>
          <div className="px-5 py-4">
            <p className="text-meta font-semibold text-ink-muted">Deposit held</p>
            <p className="mt-1"><Money cents={data.depositBalanceCents} className="text-figure text-ink" /></p>
            <p className="text-meta text-ink-muted">interest included</p>
          </div>
        </Card>
        <Card>
          <div className="px-5 py-4">
            <p className="text-meta font-semibold text-ink-muted">Paid so far</p>
            <p className="mt-1"><Money cents={standing.reduce((sum, payment) => sum + payment.amountCents, 0)} className="text-figure text-ink" /></p>
            <p className="text-meta text-ink-muted">{standing.length === 0 ? 'no payments yet' : `${standing.length} payment${standing.length === 1 ? '' : 's'} received`}</p>
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        {/* Where to pay comes first on a phone, and sits beside the invoices on a laptop. */}
        <div className="space-y-4 lg:order-2">
          <Card>
            <CardBody className="space-y-3">
              <h2 className="text-lead font-bold text-ink">Pay by EFT</h2>
              {data.bankChangedOn && data.bank ? (
                <Alert tone="warning" title={`This account changed on ${formatDate(data.bankChangedOn)}`}>
                  If {data.landlord ?? 'your landlord'} did not tell you themselves, phone them
                  {data.landlordPhone ? ` on ${data.landlordPhone}` : ''} before you pay.
                </Alert>
              ) : null}
              {data.bank ? (
                <dl className="divide-y divide-line-soft rounded-md border border-line">
                  <CopyRow label="Bank" value={data.bank.name} />
                  <CopyRow label="Account holder" value={data.bank.holder} />
                  <CopyRow label="Account number" value={data.bank.accountNumber} copy mono />
                  <CopyRow label="Branch code" value={data.bank.branchCode} copy mono />
                  <CopyRow label="Reference" value={data.reference ?? '...'} copy mono strong />
                </dl>
              ) : (
                <>
                  <p className="text-body text-ink-muted">
                    {data.landlord ?? 'Your landlord'} has not added their bank account here yet. Use the one on your lease.
                  </p>
                  <dl className="divide-y divide-line-soft rounded-md border border-line">
                    <CopyRow label="Reference" value={data.reference ?? '...'} copy mono strong />
                  </dl>
                </>
              )}
              <p className="text-meta text-ink-muted">
                Use the reference exactly, so your payment is matched to your unit.
              </p>
              <Button block size="lg" onClick={openSlip}>
                Send proof of payment
              </Button>
            </CardBody>
          </Card>

          {data.proofs.some((proof) => proof.status === 'rejected') ? (
            <Alert tone="warning" title="A slip was not accepted">
              {data.proofs.find((proof) => proof.status === 'rejected')?.rejectReason}
            </Alert>
          ) : null}

          {data.proofs.length > 0 ? (
            <Card>
              <h2 className="px-5 pb-2 pt-4 text-lead font-bold text-ink">Slips you sent</h2>
              <ul className="divide-y divide-line-soft border-t border-line-soft">
                {data.proofs.map((proof) => (
                  <li key={proof.id} className="flex items-center justify-between gap-3 px-5 py-3.5">
                    <div className="min-w-0">
                      <p className="text-body"><Money cents={proof.amountCents} /></p>
                      <p className="text-meta text-ink-muted">
                        Paid {formatDate(proof.paidOn)}
                        {proof.target === 'deposit' ? ', deposit' : ''}
                        {proof.reference ? `, ref ${proof.reference}` : ''}
                      </p>
                    </div>
                    <Badge tone={proofTone[proof.status]}>{proofLabel[proof.status]}</Badge>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>

        <div className="space-y-4 lg:order-1">
          {leaseId ? <ArrearsPanel leaseId={leaseId} landlord={false} /> : null}

          <Card>
            <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-4">
              <h2 className="text-lead font-bold text-ink">Invoices</h2>
              <Button size="sm" variant="outline" onClick={download}>
                Download statement
              </Button>
            </div>
            {data.invoices.length === 0 ? (
              <p className="border-t border-line-soft px-5 py-5 text-body text-ink-muted">
                Your first invoice appears here before your rent is due.
              </p>
            ) : (
              <ul className="divide-y divide-line-soft border-t border-line-soft">
                {[...data.invoices].reverse().map((invoice) => {
                  const proofSent = proofSentFor.has(invoice.id);
                  const month = formatMonth(invoice.period);
                  return (
                    <li key={invoice.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-3.5">
                      <div className="min-w-0">
                        <p className="text-lead font-semibold text-ink">{month}</p>
                        <p className="text-meta text-ink-muted">Due {formatDate(invoice.dueOn)}</p>
                      </div>
                      <div className="flex items-center gap-3">
                        <Money cents={invoice.totalCents} className="text-body text-ink" />
                        <Badge tone={proofSent ? 'info' : status(invoice.status).tone}>
                          {proofSent ? 'Proof sent' : status(invoice.status).label}
                        </Badge>
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={`Open the ${month} invoice as a PDF`}
                          onClick={() =>
                            openDocument(async () => (await api.post<{ key: string }>(`/invoices/${invoice.id}/render`, {})).key)
                          }
                        >
                          PDF
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {received.length > 0 ? (
            <Card>
              <h2 className="px-5 pb-2 pt-4 text-lead font-bold text-ink">Payments received</h2>
              <ul className="divide-y divide-line-soft border-t border-line-soft">
                {[...received].reverse().map((payment) => {
                  const reversal = reversalOf(payment);
                  const reason = reversal?.reason ?? payment.reason;
                  return (
                    <li key={payment.id} className="flex items-center justify-between gap-3 px-5 py-3.5">
                      <div className="min-w-0">
                        <p className="text-body font-semibold text-ink">{formatDate(payment.receivedOn)}</p>
                        <p className="truncate text-meta text-ink-muted">{payment.reference ? `Reference ${payment.reference}` : 'No reference'}</p>
                        {reversal || payment.reversedBy ? (
                          <p className="text-meta text-ink">
                            Reversed{reversal ? ` on ${formatDate(reversal.receivedOn)}` : ''}{reason ? `: ${reason}` : '.'}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-3">
                        {reversal || payment.reversedBy ? (
                          <>
                            <s className="text-ink-muted"><span className="sr-only">Reversed payment of </span><Money cents={payment.amountCents} className="text-body" /></s>
                            <Badge tone="danger">Reversed</Badge>
                          </>
                        ) : (
                          <>
                            <Money cents={payment.amountCents} className="text-body text-ink" />
                            <Badge tone="success">Received</Badge>
                          </>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          ) : null}
        </div>
      </div>

      <Modal
        open={showSlip}
        onOpenChange={(next) => {
          setShowSlip(next);
          // Closing unmounts the file picker, so a file kept in state would be sent unseen.
          if (!next) setFile(null);
        }}
        title="Send proof of payment"
        description="Upload the slip or screenshot your bank gave you."
      >
        <div className="space-y-3">
          <Select
            aria-label="What this pays"
            value={slip.invoiceId}
            onChange={(event) => setSlip({ ...slip, invoiceId: event.target.value })}
            options={[
              { value: '', label: 'Rent, oldest month first' },
              ...open.map((invoice) => ({ value: invoice.id, label: `Rent for ${formatMonth(invoice.period)}` })),
              { value: 'deposit', label: 'Deposit' },
            ]}
          />
          <CurrencyInput
            cents={slip.amountCents}
            onCentsChange={(next) => setSlip({ ...slip, amountCents: next })}
            aria-label="Amount paid"
          />
          <Input
            type="date"
            aria-label="Date paid"
            max={today()}
            value={slip.paidOn}
            onChange={(event) => setSlip({ ...slip, paidOn: event.target.value })}
          />
          <Input
            aria-label="Reference you used"
            placeholder="Reference you used (optional)"
            maxLength={60}
            value={slip.reference}
            onChange={(event) => setSlip({ ...slip, reference: event.target.value })}
          />
          <input
            type="file"
            accept={ACCEPTED_TYPES.join(',')}
            aria-label="Slip file"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            className="block w-full text-body text-ink-muted file:mr-3 file:rounded-sm file:border-0 file:bg-brand-50 file:px-3 file:py-2 file:text-body file:font-semibold file:text-brand-600"
          />
          {fileProblem ? <p className="text-meta font-semibold text-danger">{fileProblem}</p> : null}
          <Button block loading={busy} disabled={!ready} onClick={sendSlip}>
            Send
          </Button>
        </div>
      </Modal>
    </main>
  );
}

/** One line of the banking details. The ones a banking app asks for get a Copy button. */
function CopyRow({ label, value, copy = false, mono = false, strong = false }: {
  label: string; value: string; copy?: boolean; mono?: boolean; strong?: boolean;
}) {
  const { copied, failed, copy: copyValue } = useCopyToClipboard();
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5">
      <div className="min-w-0">
        <dt className="text-meta text-ink-muted">{label}</dt>
        {/* select-all so a failed copy still leaves the value one long-press from the clipboard. */}
        <dd className={`select-all break-all text-ink ${mono ? 'font-mono' : ''} ${strong ? 'text-lead font-bold' : 'text-body font-semibold'}`}>
          {value}
        </dd>
      </div>
      {copy ? (
        <Button size="sm" variant="secondary" aria-label={`Copy ${label.toLowerCase()}`} onClick={() => copyValue(value)}>
          <span aria-live="polite">{copied ? 'Copied' : failed ? 'Select it' : 'Copy'}</span>
        </Button>
      ) : null}
    </div>
  );
}
