import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router';
import {
  Alert, Badge, Button, Card, CardBody, CurrencyInput, Input, Modal, PageHeader, Select, TagField, useToast,
} from '@hlonie/toolbox/ui';
import { formatZar } from '@hlonie/toolbox/utils';
import { api, humanError } from '../api/client';
import { formatDate, formatMonth, status } from '../lib/format';
import { localToday } from '../lib/dates';
import { QueryState } from '../components/query-state';
import { ArrearsPanel } from '../components/arrears-panel';
import { Money } from '../components/money';

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
  payments: { id: string; amountCents: number; receivedOn: string; reference: string | null }[];
  proofs: Proof[];
}

const proofTone = { pending: 'info', accepted: 'success', rejected: 'danger' } as const;
const proofLabel = { pending: 'Waiting for landlord', accepted: 'Accepted', rejected: 'Not accepted' } as const;

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];
const MAX_BYTES = 10 * 1024 * 1024;
// The device's calendar (SAST for our users), not UTC: before 02:00 UTC was still yesterday.
const today = localToday;

const csvCell = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;

/** There is no server-rendered PDF for a running statement, only for the exit statement, so
    the download is built from the same rows the screen is already showing. CSV, because the
    thing a tenant does with this is hand it to a bank or paste it into a dispute. */
function statementCsv(statement: Statement): string {
  const rows: (string | number)[][] = [['Date', 'Description', 'Reference', 'Debit', 'Credit']];
  for (const invoice of statement.invoices) {
    rows.push([invoice.dueOn, `Rent ${invoice.period}`, '', (invoice.totalCents / 100).toFixed(2), '']);
  }
  for (const payment of statement.payments) {
    rows.push([payment.receivedOn, 'Payment received', payment.reference ?? '', '', (payment.amountCents / 100).toFixed(2)]);
  }
  rows.push([]);
  rows.push(['', 'Balance outstanding', '', (statement.balanceCents / 100).toFixed(2), '']);
  rows.push(['', 'Deposit held', '', '', (statement.depositBalanceCents / 100).toFixed(2)]);
  return rows.map((row) => row.map(csvCell).join(',')).join('\n');
}

// A function, not a constant: computed at module load, paidOn stayed on the day the app was
// opened, so a tab left open overnight offered yesterday as the payment date.
const blankSlip = () => ({ invoiceId: '', amountCents: null as number | null, paidOn: today(), reference: '' });
type Slip = ReturnType<typeof blankSlip>;
const untouched = (slip: Slip) => !slip.invoiceId && slip.amountCents === null && !slip.reference;

export function TenantRent() {
  const { leaseId } = useParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['statement', leaseId],
    queryFn: () => api.get<Statement>(`/leases/${leaseId}/statement`),
  });

  const [showSlip, setShowSlip] = useState(false);
  const [slip, setSlip] = useState(blankSlip);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const balance = data?.balanceCents ?? 0;
  const open = data?.invoices.filter((invoice) => invoice.status === 'issued' || invoice.status === 'part_paid') ?? [];
  const pendingFor = new Set(
    data?.proofs.filter((proof) => proof.status === 'pending').map((proof) => proof.invoiceId ?? 'any') ?? [],
  );

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
      await queryClient.invalidateQueries({ queryKey: ['statement', leaseId] });
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

  return (
    <main className="mx-auto max-w-lg px-4 py-6">
      <PageHeader
        title="Rent"
        description={balance <= 0 ? 'You are fully paid up.' : `${formatZar(balance / 100)} outstanding.`}
      />
      <Card className="mb-4">
        <CardBody className="space-y-3">
          <p className="label">Pay by EFT</p>
          {data.bankChangedOn && data.bank ? (
            <Alert tone="warning" title={`This account changed on ${formatDate(data.bankChangedOn)}`}>
              If {data.landlord ?? 'your landlord'} did not tell you themselves, phone them
              {data.landlordPhone ? ` on ${data.landlordPhone}` : ''} before you pay.
            </Alert>
          ) : null}
          {data.bank ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-body">
              <dt className="text-ink-muted">Bank</dt>
              <dd>{data.bank.name}</dd>
              <dt className="text-ink-muted">Account holder</dt>
              <dd>{data.bank.holder}</dd>
              <dt className="text-ink-muted">Account number</dt>
              <dd className="font-mono tabular-nums">{data.bank.accountNumber}</dd>
              <dt className="text-ink-muted">Branch code</dt>
              <dd className="font-mono tabular-nums">{data.bank.branchCode}</dd>
            </dl>
          ) : (
            <p className="text-meta text-ink-muted">
              {data.landlord ?? 'Your landlord'} has not added their bank account here yet. Use the one on your lease.
            </p>
          )}
          <TagField label="Reference" value={data?.reference ?? '...'} />
          <p className="text-xs text-ink-muted">
            Use it exactly, so your payment is matched to your unit. Your deposit stands at{' '}
            {formatZar((data?.depositBalanceCents ?? 0) / 100)}, interest included.
          </p>
          <Button block variant="outline" disabled={!data} onClick={() => {
            // Fresh date each time it opens, unless they left a half-filled slip to come back to.
            setSlip((current) => (untouched(current) ? blankSlip() : current));
            setShowSlip(true);
          }}>
            Send proof of payment
          </Button>
        </CardBody>
      </Card>

      {data?.proofs.some((proof) => proof.status === 'rejected') ? (
        <Alert tone="warning" title="A slip was not accepted" className="mb-4">
          {data.proofs.find((proof) => proof.status === 'rejected')?.rejectReason}
        </Alert>
      ) : null}

      {leaseId ? <ArrearsPanel leaseId={leaseId} landlord={false} /> : null}

      <div className="space-y-3">
        {data?.invoices.map((invoice) => {
          const proofSent = invoice.status !== 'paid' && (pendingFor.has(invoice.id) || pendingFor.has('any'));
          return (
            <Card key={invoice.id}>
              <CardBody className="flex items-center justify-between">
                <div>
                  <p className="text-lead font-semibold text-ink">{formatMonth(invoice.period)}</p>
                  <p className="text-xs text-ink-muted">Due {formatDate(invoice.dueOn)}</p>
                </div>
                <div className="flex items-center gap-3">
                  <Money cents={invoice.totalCents} className="text-body" />
                  <Badge tone={proofSent ? 'info' : status(invoice.status).tone}>
                    {proofSent ? 'Proof sent' : status(invoice.status).label}
                  </Badge>
                </div>
              </CardBody>
            </Card>
          );
        })}
      </div>

      {data && data.proofs.length > 0 ? (
        <section className="mt-6">
          <h2 className="label mb-2">Slips you sent</h2>
          <div className="space-y-2">
            {data.proofs.map((proof) => (
              <Card key={proof.id}>
                <CardBody className="flex items-center justify-between">
                  <div>
                    <p className="text-body"><Money cents={proof.amountCents} /></p>
                    <p className="text-xs text-ink-muted">
                      Paid {formatDate(proof.paidOn)}
                      {proof.target === 'deposit' ? ', deposit' : ''}
                      {proof.reference ? `, ref ${proof.reference}` : ''}
                    </p>
                  </div>
                  <Badge tone={proofTone[proof.status]}>{proofLabel[proof.status]}</Badge>
                </CardBody>
              </Card>
            ))}
          </div>
        </section>
      ) : null}

      <Button block variant="secondary" className="mt-5" disabled={!data} onClick={download}>
        Download statement
      </Button>

      <Modal
        open={showSlip}
        onOpenChange={(next) => setShowSlip(next)}
        title="Send proof of payment"
        description="Upload the slip or screenshot your bank gave you."
      >
        <div className="space-y-3">
          <Select
            value={slip.invoiceId}
            onChange={(event) => setSlip({ ...slip, invoiceId: event.target.value })}
            options={[
              { value: '', label: 'Rent, oldest month first' },
              ...open.map((invoice) => ({ value: invoice.id, label: `Rent for ${invoice.period}` })),
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
            className="block w-full text-body text-ink-muted file:mr-3 file:rounded-sm file:border-0 file:bg-brand-50 file:px-3 file:py-2 file:text-body file:font-semibold file:text-brand-500"
          />
          {fileProblem ? <p className="text-xs text-danger">{fileProblem}</p> : null}
          <Button block loading={busy} disabled={!ready} onClick={sendSlip}>
            Send
          </Button>
        </div>
      </Modal>
    </main>
  );
}
