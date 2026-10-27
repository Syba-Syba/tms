import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Alert, Button, Card, CardBody, PageHeader, UploadTile, useToast, type UploadState } from '@hlonie/toolbox/ui';
import { api, humanError } from '../api/client';
import { pickPhoto, putFile } from '../lib/photos';

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
  const toast = useToast();
  const [state, setState] = useState<Record<string, UploadState>>({});
  const [previews, setPreviews] = useState<Record<string, string>>({});

  const capture = async (kind: Kind) => {
    let photo: Awaited<ReturnType<typeof pickPhoto>>;
    try {
      photo = await pickPhoto();
    } catch (error) {
      toast.show({ title: 'Could not read that photo', description: humanError(error), tone: 'danger' });
      return;
    }
    if (!photo) return;

    setPreviews((current) => ({ ...current, [kind]: photo.dataUrl }));
    setState((current) => ({ ...current, [kind]: 'uploading' }));

    try {
      const { uploadUrl } = await api.post<{ uploadUrl: string }>(
        `/applications/${applicationId}/documents/presign`,
        { kind, contentType: photo.contentType, sizeBytes: photo.blob.size },
      );
      await putFile(uploadUrl, photo.blob, photo.contentType);
      setState((current) => ({ ...current, [kind]: 'synced' }));
    } catch (error) {
      setState((current) => ({ ...current, [kind]: 'failed' }));
      toast.show({ title: 'Upload failed', description: humanError(error), tone: 'danger' });
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
                  {state[item.kind] === 'synced'
                    ? 'Received'
                    : state[item.kind] === 'failed'
                      ? 'Upload failed. Tap the photo to retry.'
                      : state[item.kind] === 'uploading'
                        ? 'Uploading'
                        : 'Not uploaded yet'}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={state[item.kind] === 'uploading'}
                onClick={() => capture(item.kind)}
              >
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
