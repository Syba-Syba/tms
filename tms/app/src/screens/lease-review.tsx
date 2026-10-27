import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import {
  Alert,
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
import { Ledger } from '../components/money';
import { QueryState } from '../components/query-state';
import { useOpenDocument } from '../lib/open-document';

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
      refetch();
    } catch (error) {
      toast.show({ title: 'Not signed', description: humanError(error), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const stepIndex = data.status === 'active' || (isRenewal && signedParties.length === 2) ? 4 : 2 + signedParties.length;

  return (
    <main className="mx-auto max-w-lg px-4 py-6">
      <PageHeader
        title={data.viewer.isLandlord ? 'The lease' : 'Your lease'}
        description="Read it, then sign. Both of you get the same document."
      />

      <Card className="mb-4">
        <CardBody className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <TagField label="Lease" value={data.ref} />
            <TagField label="Unit" value={data.unit} />
          </div>
          <dl className="grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-ink-muted">Monthly rent</dt>
            <dd className="text-right font-mono"><Ledger cents={data.monthlyRentCents} /></dd>
            <dt className="text-ink-muted">Deposit</dt>
            <dd className="text-right font-mono"><Ledger cents={data.depositCents} /></dd>
            <dt className="text-ink-muted">Term</dt>
            <dd className="text-right">{data.startDate} to {data.endDate}</dd>
            <dt className="text-ink-muted">Escalation</dt>
            <dd className="text-right">{data.escalationPct}% a year</dd>
          </dl>
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

      <Card className="mb-4">
        <CardBody>
          <Stepper
            current={stepIndex}
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
                ? { title: `Starts ${data.startDate}`, detail: 'Takes over from the current lease' }
                : { title: 'Lease active', detail: 'Deposit due within 7 days' },
            ]}
          />
        </CardBody>
      </Card>

      {data.status === 'active' ? (
        <Alert tone="success" title="This lease is active">
          Both signatures are on file. Everything about the tenancy lives on the{' '}
          <Link to={`/leases/${data.id}`} className="font-bold text-brand-500">lease page</Link>.
        </Alert>
      ) : null}

      {isRenewal && signedParties.length === 2 ? (
        <Alert tone="success" title={`Signed · starts ${data.startDate}`}>
          Both signatures are on file. The new lease takes over from the current one on its start date.
        </Alert>
      ) : null}

      {iHaveSigned && signable && signedParties.length < 2 ? (
        <Alert tone="info" title="Your signature is on file">
          Waiting on the {party === 'tenant' ? 'landlord' : 'tenant'} to sign.
        </Alert>
      ) : null}

      {canSign ? (
        <Card>
          <CardBody className="space-y-4">
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
    </main>
  );
}
