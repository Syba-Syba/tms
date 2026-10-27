import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import {
  Alert,
  Button,
  Card,
  CardBody,
  OtpInput,
  PageHeader,
  SignaturePad,
  Spinner,
  Stepper,
  TagField,
  useToast,
  type SignaturePadHandle,
} from '@hlonie/toolbox/ui';
import { api, openDocument, humanError } from '../api/client';
import { Ledger } from '../components/money';
import { formatDate } from '../lib/format';

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
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['lease', leaseId],
    queryFn: () => api.get<Lease>(`/leases/${leaseId}`),
  });

  if (isLoading || !data) return <main className="p-16 text-center"><Spinner /></main>;

  const party: 'tenant' | 'landlord' = data.viewer.isLandlord ? 'landlord' : 'tenant';
  const signedParties = data.signatures.map((signature) => signature.party);
  const iHaveSigned = signedParties.includes(party);
  const canSign = data.status === 'out_for_signature' && !iHaveSigned && data.hasDocument;

  const sign = async () => {
    if (padRef.current?.isEmpty()) {
      toast.show({ title: 'Signature missing', description: 'Sign above the line first.', tone: 'warning' });
      return;
    }
    setBusy(true);
    try {
      await api.post(`/leases/${leaseId}/signature`, {
        party,
        signatureBase64: padRef.current?.toDataUrl(),
        otpVerified: otp.length === 6,
        // The fingerprint of the exact document rendered for this lease. The server rejects
        // a mismatch, so nobody signs a version they have not seen.
        pdfSha256: data.pdfSha256,
      });
      toast.show({ title: 'Lease signed', tone: 'success' });
      setOtp('');
      refetch();
    } catch (error) {
      toast.show({ title: 'Not signed', description: humanError(error), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const stepIndex = data.status === 'active' ? 4 : 2 + signedParties.length;

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
            <dd className="text-right">{formatDate(data.startDate)} to {formatDate(data.endDate)}</dd>
            <dt className="text-ink-muted">Escalation</dt>
            <dd className="text-right">{data.escalationPct}% a year</dd>
          </dl>
          {data.pdfKey ? (
            <Button block variant="outline" onClick={() => openDocument(data.pdfKey!)}>
              Open the lease PDF
            </Button>
          ) : (
            <Alert tone="info" title="Document not rendered yet">
              The landlord generates the PDF from the Applications screen before anyone signs.
            </Alert>
          )}
        </CardBody>
      </Card>

      <Card className="mb-4">
        <CardBody>
          <Stepper
            current={stepIndex}
            steps={[
              { title: 'Application approved' },
              { title: 'Lease generated' },
              {
                title: 'Landlord signature',
                detail: signedParties.includes('landlord') ? 'On file' : undefined,
              },
              {
                title: 'Tenant signature',
                detail: signedParties.includes('tenant') ? 'On file' : undefined,
              },
              { title: 'Lease active', detail: 'Deposit due within 7 days' },
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

      {iHaveSigned && data.status === 'out_for_signature' ? (
        <Alert tone="info" title="Your signature is on file">
          Waiting on the {party === 'tenant' ? 'landlord' : 'tenant'} to sign.
        </Alert>
      ) : null}

      {canSign ? (
        <Card>
          <CardBody className="space-y-4">
            <div>
              <p className="mb-2 text-sm font-medium">PIN sent to your mobile</p>
              <OtpInput value={otp} onChange={setOtp} />
            </div>
            <SignaturePad ref={padRef} />
            <Button block loading={busy} disabled={otp.length !== 6} onClick={sign}>
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
