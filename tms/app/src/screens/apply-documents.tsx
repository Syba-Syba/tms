import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { Alert, Button, Card, CardBody, PageHeader, UploadTile, type UploadState } from '@hlonie/toolbox/ui';
import { api } from '../api/client';

const REQUIRED = [
  { kind: 'id_copy', label: 'ID document' },
  { kind: 'payslip', label: 'Latest payslip' },
  { kind: 'bank_statement', label: 'Three months bank statements' },
  { kind: 'proof_of_address', label: 'Proof of address' },
] as const;

type Kind = (typeof REQUIRED)[number]['kind'];

export function ApplyDocuments() {
  const { applicationId } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState<Record<string, UploadState>>({});
  const [previews, setPreviews] = useState<Record<string, string>>({});

  const capture = async (kind: Kind) => {
    const photo = await Camera.getPhoto({
      quality: 70,
      width: 1600, // capped so embedded report photos stay small
      resultType: CameraResultType.DataUrl,
      source: CameraSource.Prompt,
    });
    if (!photo.dataUrl) return;

    setPreviews((current) => ({ ...current, [kind]: photo.dataUrl! }));
    setState((current) => ({ ...current, [kind]: 'uploading' }));

    const blob = await (await fetch(photo.dataUrl)).blob();
    try {
      const { uploadUrl } = await api.post<{ uploadUrl: string }>(
        `/applications/${applicationId}/documents/presign`,
        { kind, contentType: 'image/jpeg', sizeBytes: blob.size },
      );
      await fetch(uploadUrl, { method: 'PUT', body: blob, headers: { 'content-type': 'image/jpeg' } });
      setState((current) => ({ ...current, [kind]: 'synced' }));
    } catch {
      setState((current) => ({ ...current, [kind]: 'failed' }));
    }
  };

  const done = REQUIRED.every((item) => state[item.kind] === 'synced');

  return (
    <main className="mx-auto max-w-lg px-4 py-6">
      <PageHeader title="Upload documents" description="Photograph each one. They upload as you go." />
      <Alert tone="info" title="Why we ask">
        These confirm who you are and that the rent fits your income. They are encrypted and deleted
        twelve months after the application closes.
      </Alert>
      <div className="mt-4 space-y-3">
        {REQUIRED.map((item) => (
          <Card key={item.kind}>
            <CardBody className="flex items-center gap-4">
              <UploadTile
                className="w-20"
                src={previews[item.kind]}
                state={state[item.kind] ?? 'queued'}
                onRetry={() => capture(item.kind)}
              />
              <div className="flex-1">
                <p className="text-sm font-medium">{item.label}</p>
                <p className="text-xs text-ink-muted">
                  {state[item.kind] === 'synced' ? 'Received' : 'Not uploaded yet'}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => capture(item.kind)}>
                {state[item.kind] ? 'Replace' : 'Capture'}
              </Button>
            </CardBody>
          </Card>
        ))}
      </div>
      <Button block className="mt-5" disabled={!done} onClick={() => navigate('/')}>
        Submit application
      </Button>
    </main>
  );
}
