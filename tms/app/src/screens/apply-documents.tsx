import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router';
import { Alert, Button, Card, CardBody, PageHeader, UploadTile, useToast, type UploadState } from '@hlonie/toolbox/ui';
import { api, humanError } from '../api/client';
import { photoFromFile, putFile } from '../lib/photos';
import { CreditCheckApplicant } from '../components/credit-check';
import { PRIVACY_VERSION } from '../lib/privacy';

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
  const [pdfs, setPdfs] = useState<Record<string, boolean>>({});
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});

  // What is already on file. Upload state used to live only here, so an applicant coming back
  // saw every document missing and could not finish.
  const onFile = useQuery({
    queryKey: ['application-documents', applicationId],
    queryFn: () =>
      api.get<{ items: { kind: string; contentType: string; viewUrl: string }[] }>(
        `/applications/${applicationId}/documents`,
      ),
    enabled: Boolean(applicationId),
  });
  useEffect(() => {
    const items = onFile.data?.items ?? [];
    if (items.length === 0) return;
    // A capture in progress on this screen wins over what the server had before it.
    setState((current) => {
      const next = { ...current };
      for (const item of items) next[item.kind] ??= 'synced';
      return next;
    });
    setPreviews((current) => {
      const next = { ...current };
      for (const item of items) {
        if (item.contentType.startsWith('image/')) next[item.kind] ??= item.viewUrl;
      }
      return next;
    });
    setPdfs((current) => {
      const next = { ...current };
      for (const item of items) next[item.kind] ??= item.contentType === 'application/pdf';
      return next;
    });
  }, [onFile.data]);

  // Statements and payslips usually come as PDFs from internet banking, and one PDF holds all
  // three months. A PDF goes up as it is; a photo is redrawn as a JPEG, as everywhere else.
  const capture = (kind: Kind) => inputs.current[kind]?.click();

  const upload = async (kind: Kind, file: File) => {
    let picked: { blob: Blob; contentType: 'image/jpeg' | 'application/pdf'; dataUrl: string | null };
    try {
      if (file.type === 'application/pdf') {
        picked = { blob: file, contentType: 'application/pdf', dataUrl: null };
      } else {
        const photo = await photoFromFile(file);
        picked = { blob: photo.blob, contentType: photo.contentType, dataUrl: photo.dataUrl };
      }
    } catch (error) {
      toast.show({ title: 'Could not read that file', description: humanError(error), tone: 'danger' });
      return;
    }

    setPreviews((current) => {
      const next = { ...current };
      if (picked.dataUrl) next[kind] = picked.dataUrl;
      else delete next[kind];
      return next;
    });
    setPdfs((current) => ({ ...current, [kind]: picked.contentType === 'application/pdf' }));
    setState((current) => ({ ...current, [kind]: 'uploading' }));

    try {
      const { uploadUrl, key } = await api.post<{ uploadUrl: string; key: string }>(
        `/applications/${applicationId}/documents/presign`,
        { kind, contentType: picked.contentType, sizeBytes: picked.blob.size },
      );
      await putFile(uploadUrl, picked.blob, picked.contentType);
      // Only a confirmed upload is on file for the landlord, and it replaces any earlier one.
      await api.post(`/applications/${applicationId}/documents/confirm`, { key });
      setState((current) => ({ ...current, [kind]: 'synced' }));
    } catch (error) {
      setState((current) => ({ ...current, [kind]: 'failed' }));
      toast.show({ title: 'Upload failed', description: humanError(error), tone: 'danger' });
    }
  };

  // The application was sent when it was created (apply-start); this screen only adds files to
  // it, so leaving is safe whenever nothing is mid-upload.
  const uploading = Object.values(state).some((value) => value === 'uploading');

  return (
    <main className="mx-auto max-w-lg px-4 py-6">
      <PageHeader
        title="Upload documents"
        description="Photograph each one, or choose a PDF from your phone. They upload as you go."
      />
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
                <p className="text-body font-medium">{item.label}</p>
                <p className="text-xs text-ink-muted">
                  {state[item.kind] === 'synced'
                    ? pdfs[item.kind] ? 'Received (PDF)' : 'Received'
                    : state[item.kind] === 'failed'
                      ? 'Upload failed. Tap retry to choose it again.'
                      : state[item.kind] === 'uploading'
                        ? 'Uploading'
                        : 'Not uploaded yet'}
                </p>
              </div>
              <input
                ref={(element) => {
                  inputs.current[item.kind] = element;
                }}
                type="file"
                accept="image/jpeg,image/png,application/pdf"
                className="hidden"
                aria-label={`Choose a file for ${item.label}`}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  // Cleared so choosing the same file again still fires a change.
                  event.target.value = '';
                  if (file) void upload(item.kind, file);
                }}
              />
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
      {applicationId ? (
        <Card className="mt-3">
          <CardBody className="space-y-2">
            <h2 className="text-body font-medium">Credit check</h2>
            <CreditCheckApplicant applicationId={applicationId} privacyVersion={PRIVACY_VERSION} />
          </CardBody>
        </Card>
      ) : null}
      <Button block className="mt-5" disabled={uploading} onClick={() => navigate('/')}>
        Done
      </Button>
    </main>
  );
}
