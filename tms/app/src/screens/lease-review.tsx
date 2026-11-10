import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  CardBody,
  PageHeader,
  SignaturePad,
  Stepper,
  TagField,
  useToast,
  type SignaturePadHandle,
} from '@hlonie/toolbox/ui';
import { api, humanError } from '../api/client';
import { Money } from '../components/money';
import { formatDate } from '../lib/format';
import { QueryState } from '../components/query-state';
import { useOpenDocument } from '../lib/open-document';
import { PAGE } from '../lib/layout';

/**
 * Which of the five steps are done, and the first one still waiting. Counting signatures
 * (2 + how many) showed the landlord as signed when only the tenant had.
 */
export function signingProgress(status: string, signedParties: string[]): { done: boolean[]; current: number } {
  const landlord = signedParties.includes('landlord');
  const tenant = signedParties.includes('tenant');
  // An accepted renewal is 'scheduled' once both have signed: it is waiting only for its date.
  const finished = status === 'active' || (status === 'scheduled' && landlord && tenant);
  const done = [true, true, landlord || finished, tenant || finished, finished];
  const current = done.indexOf(false);
  return { done, current: current === -1 ? done.length : current };
}

interface Lease {
  id: string;
  ref: string;
  status: string;
  unit: string;
  tenant: string;
  startDate: string;
  endDate: string;
  monthlyRentCents: number;
  escalationPct: number;
  depositCents: number;
  hasDocument: boolean;
  pdfKey: string | null;
  pdfSha256: string | null;
  signatures: { party: 'tenant' | 'landlord'; signedAt: string }[];
  viewer: { isLandlord: boolean; isTenant: boolean };
}

export function LeaseReview() {
  const { leaseId } = useParams();
  const padRef = useRef<SignaturePadHandle>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const openDocument = useOpenDocument();
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['lease', leaseId],
    queryFn: () => api.get<Lease>(`/leases/${leaseId}`),
  });

  if (!data) {
    return <QueryState isLoading={isLoading} isError={isError} error={error} onRetry={refetch} what="This lease" />;
  }

  const party: 'tenant' | 'landlord' = data.viewer.isLandlord ? 'landlord' : 'tenant';
  const signedParties = data.signatures.map((signature) => signature.party);
  const iHaveSigned = signedParties.includes(party);
  // 'scheduled' is an accepted renewal, signed the same way before it starts.
  const signable = data.status === 'out_for_signature' || data.status === 'scheduled';
  const canSign = signable && !iHaveSigned && data.hasDocument;
  const isRenewal = data.status === 'scheduled';

  const generate = async () => {
    setBusy(true);
    try {
      await api.post(`/leases/${leaseId}/render`, {});
      toast.show({ title: 'Lease document ready', tone: 'success' });
      queryClient.invalidateQueries({ queryKey: ['applications'] });
      refetch();
    } catch (error) {
      toast.show({ title: 'Could not generate it', description: humanError(error), tone: 'danger' });
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
      // No one-time PIN is sent: nothing on the server issues one, and the screen used to
      // claim otherwise. The signature is tied to the document by its fingerprint instead.
      await api.post(`/leases/${leaseId}/signature`, {
        party,
        signatureBase64: padRef.current?.toDataUrl(),
        // The fingerprint of the exact document rendered for this lease. The server rejects
        // a mismatch, so nobody signs a version they have not seen.
        pdfSha256: data.pdfSha256,
      });
      toast.show({ title: 'Lease signed', tone: 'success' });
      queryClient.invalidateQueries({ queryKey: ['leases'] });
      // The landlord's queue and the applicant's home both say where signing stands.
      queryClient.invalidateQueries({ queryKey: ['applications'] });
      queryClient.invalidateQueries({ queryKey: ['my-applications'] });
      refetch();
    } catch (error) {
      toast.show({ title: 'Not signed', description: humanError(error), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const progress = signingProgress(data.status, signedParties);

  const other = party === 'tenant' ? 'landlord' : 'tenant';
  const fact = 'rounded-md bg-surface-muted px-4 py-3';

  return (
    <main className={PAGE.wide}>
      <PageHeader
        title={data.viewer.isLandlord ? 'The lease' : 'Your lease'}
        description="Read it, then sign. Both of you get the same document."
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-5">
          <Card>
            <CardBody className="space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar name={data.tenant} size="lg" />
                  <div className="min-w-0">
                    <p className="truncate text-lead font-bold text-ink">{data.tenant}</p>
                    <p className="text-meta text-ink-muted">Tenant, {data.unit}</p>
                  </div>
                </div>
                <Badge tone={data.status === 'active' ? 'success' : signedParties.length === 2 ? 'success' : 'info'}>
                  {data.status === 'active'
                    ? 'Active'
                    : signedParties.length === 2
                      ? 'Signed by both'
                      : signable
                        ? `${signedParties.length} of 2 signatures`
                        : data.status.replace(/_/g, ' ')}
                </Badge>
              </div>

              <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <div className={fact}>
                  <dt className="text-meta text-ink-muted">Monthly rent</dt>
                  <dd className="text-title text-ink"><Money cents={data.monthlyRentCents} /></dd>
                </div>
                <div className={fact}>
                  <dt className="text-meta text-ink-muted">Deposit</dt>
                  <dd className="text-title text-ink"><Money cents={data.depositCents} /></dd>
                </div>
                <div className={fact}>
                  <dt className="text-meta text-ink-muted">Term</dt>
                  <dd className="text-body font-semibold text-ink">{formatDate(data.startDate)} to {formatDate(data.endDate)}</dd>
                </div>
                <div className={fact}>
                  <dt className="text-meta text-ink-muted">Escalation</dt>
                  <dd className="text-body font-semibold text-ink">{data.escalationPct}% a year</dd>
                </div>
              </dl>

              <div className="flex flex-wrap gap-2">
                <TagField label="Lease" value={data.ref} />
                <TagField label="Unit" value={data.unit} />
              </div>

              {data.pdfKey ? (
                <Button block variant="outline" onClick={() => openDocument(data.pdfKey!)}>
                  Open the lease PDF
                </Button>
              ) : (
                <Alert tone="info" title="Document not rendered yet">
                  {data.viewer.isLandlord && signable ? (
                    <Button size="sm" loading={busy} onClick={generate}>Generate the document</Button>
                  ) : (
                    'The landlord generates the PDF before anyone signs.'
                  )}
                </Alert>
              )}
            </CardBody>
          </Card>

          {data.status === 'active' ? (
            <Alert tone="success" title="This lease is active">
              Both signatures are on file. Everything about the tenancy lives on the{' '}
              <Link to={`/leases/${data.id}`} className="font-bold text-brand-500 underline underline-offset-2">lease page</Link>.
            </Alert>
          ) : null}

          {isRenewal && signedParties.length === 2 ? (
            <Alert tone="success" title={`Signed · starts ${formatDate(data.startDate)}`}>
              Both signatures are on file. The new lease takes over from the current one on its start date.
            </Alert>
          ) : null}

          {iHaveSigned && signable && signedParties.length < 2 ? (
            <Alert tone="info" title="Your signature is on file">
              Waiting on the {other} to sign.
            </Alert>
          ) : null}

          {canSign ? (
            <Card>
              <CardBody className="space-y-4">
                <div>
                  <h2 className="text-lead font-bold text-ink">Sign here</h2>
                  <p className="text-meta text-ink-muted">Open the PDF and read it first. Then sign with your finger or the mouse.</p>
                </div>
                <SignaturePad ref={padRef} />
                <Button block loading={busy} onClick={sign}>
                  Sign as the {party}
                </Button>
                <p className="text-xs text-ink-muted">
                  Signing records the time, your device and a fingerprint of this exact document.
                </p>
              </CardBody>
            </Card>
          ) : null}
        </div>

        <aside className="space-y-5">
          <Card>
            <CardBody className="space-y-4">
              <h2 className="text-lead font-bold text-ink">Where this lease stands</h2>
              <Stepper
                className="-ml-14"
                current={progress.current}
                steps={[
                  { title: isRenewal ? 'Renewal accepted' : 'Application approved' },
                  { title: 'Lease generated' },
                  {
                    title: 'Landlord signature',
                    detail: signedParties.includes('landlord') ? 'On file' : undefined,
                  },
                  {
                    title: 'Tenant signature',
                    detail: signedParties.includes('tenant') ? 'On file' : undefined,
                  },
                  isRenewal
                    ? { title: `Starts ${formatDate(data.startDate)}`, detail: 'Takes over from the current lease' }
                    : { title: 'Lease active', detail: 'Deposit due within 7 days' },
                ].map((step, index) => ({ ...step, done: progress.done[index] }))}
              />
            </CardBody>
          </Card>
          <Card>
            <CardBody className="space-y-2">
              <h2 className="text-lead font-bold text-ink">What happens next</h2>
              <p className="text-body text-ink-muted">
                {data.status === 'active'
                  ? 'The lease is running. Rent is invoiced each month and the deposit is held in its own ledger, earning the tenant interest.'
                  : isRenewal
                    ? 'Once both of you have signed, the new lease starts on its date and takes over from the current one. Nothing else to do.'
                    : data.viewer.isLandlord
                      ? 'Once both of you have signed, the lease becomes active. The tenant pays the deposit within 7 days and you book the move-in inspection from the lease page.'
                      : 'Once both of you have signed, the lease becomes active. You pay the deposit within 7 days and the landlord books the move-in inspection with you.'}
              </p>
            </CardBody>
          </Card>
        </aside>
      </div>
    </main>
  );
}
