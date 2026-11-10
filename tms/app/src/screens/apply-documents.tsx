import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router';
import { Badge, Button, Card, CardBody, ProgressBar, UploadTile, useToast, type UploadState } from '@hlonie/toolbox/ui';
import { api, humanError } from '../api/client';
import { photoFromFile, putFile } from '../lib/photos';
import { CreditCheckApplicant } from '../components/credit-check';
import { PRIVACY_VERSION } from '../lib/privacy';
import { AuthHeading, AuthLayout } from '../components/auth-layout';
import { LinkButton } from '../components/link-button';

const REQUIRED = [
  { kind: 'id_copy', label: 'ID document', hint: 'One photo or PDF.' },
  { kind: 'payslip', label: 'Latest payslip', hint: 'One photo or PDF.' },
  { kind: 'bank_statement', label: 'Three months bank statements', hint: 'One file. A PDF from internet banking holds all three months.' },
  { kind: 'proof_of_address', label: 'Proof of address', hint: 'One photo or PDF.' },
] as const;

/** Extra pages one application may keep (the server's cap on `other` documents). */
const MAX_EXTRA = 10;

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
      api.get<{ items: { id?: string; kind: string; contentType: string; viewUrl: string }[] }>(
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

  type Picked = { blob: Blob; contentType: 'image/jpeg' | 'application/pdf'; dataUrl: string | null };

  /** A chosen file, ready to send. Some Android file managers hand over a PDF with no type at
      all, which used to go down the photo path and fail, so the name is believed too. */
  const read = async (file: File): Promise<Picked | null> => {
    try {
      if (file.type === 'application/pdf' || (!file.type && /\.pdf$/i.test(file.name))) {
        return { blob: file, contentType: 'application/pdf', dataUrl: null };
      }
      const photo = await photoFromFile(file);
      return { blob: photo.blob, contentType: photo.contentType, dataUrl: photo.dataUrl };
    } catch (error) {
      toast.show({ title: 'Could not read that file', description: humanError(error), tone: 'danger' });
      return null;
    }
  };

  const send = async (kind: Kind | 'other', picked: Picked) => {
    const { uploadUrl, key } = await api.post<{ uploadUrl: string; key: string }>(
      `/applications/${applicationId}/documents/presign`,
      { kind, contentType: picked.contentType, sizeBytes: picked.blob.size },
    );
    await putFile(uploadUrl, picked.blob, picked.contentType);
    // Only a confirmed upload is on file for the landlord.
    await api.post(`/applications/${applicationId}/documents/confirm`, { key });
  };

  const upload = async (kind: Kind, file: File) => {
    const picked = await read(file);
    if (!picked) return;

    setPreviews((current) => {
      const next = { ...current };
      if (picked.dataUrl) next[kind] = picked.dataUrl;
      else delete next[kind];
      return next;
    });
    setPdfs((current) => ({ ...current, [kind]: picked.contentType === 'application/pdf' }));
    setState((current) => ({ ...current, [kind]: 'uploading' }));

    try {
      // It replaces any earlier file of the same kind.
      await send(kind, picked);
      setState((current) => ({ ...current, [kind]: 'synced' }));
    } catch (error) {
      setState((current) => ({ ...current, [kind]: 'failed' }));
      toast.show({ title: 'Upload failed', description: humanError(error), tone: 'danger' });
    }
  };

  // Extra pages: a statement photographed page by page, a second payslip. These are kept side
  // by side (the server's `other` kind), where a second file on a row above replaces the first.
  const extraInput = useRef<HTMLInputElement | null>(null);
  const [extraUploads, setExtraUploads] = useState<{ id: number; src: string | null; state: UploadState }[]>([]);
  const extras = (onFile.data?.items ?? []).filter((item) => item.kind === 'other');
  const extrasFull = extras.length + extraUploads.filter((entry) => entry.state === 'uploading').length >= MAX_EXTRA;
  const uploadExtra = async (file: File) => {
    const picked = await read(file);
    if (!picked) return;
    const id = Date.now() + Math.random();
    setExtraUploads((current) => [...current, { id, src: picked.dataUrl, state: 'uploading' }]);
    try {
      await send('other', picked);
      await onFile.refetch();
      setExtraUploads((current) => current.filter((entry) => entry.id !== id));
    } catch (error) {
      setExtraUploads((current) => current.map((entry) => (entry.id === id ? { ...entry, state: 'failed' } : entry)));
      toast.show({ title: 'Upload failed', description: humanError(error), tone: 'danger' });
    }
  };

  // The application was sent when it was created (apply-start); this screen only adds files to
  // it, so leaving is safe whenever nothing is mid-upload.
  const uploading =
    Object.values(state).some((value) => value === 'uploading') || extraUploads.some((entry) => entry.state === 'uploading');
  const received = REQUIRED.filter((item) => state[item.kind] === 'synced').length;

  return (
    <AuthLayout wide top={<LinkButton to="/" size="sm">Your home</LinkButton>}>
      <AuthHeading title="Upload documents">
        Photograph each one, or choose a PDF from your phone. They upload as you go.
      </AuthHeading>

      <div className="mb-5 rounded-md bg-brand-50 px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-lead font-bold text-ink">{received} of {REQUIRED.length} received</p>
          {received === REQUIRED.length ? <Badge tone="success">All four are in</Badge> : null}
        </div>
        <ProgressBar className="mt-2" value={received} max={REQUIRED.length} />
        <p className="mt-2 text-meta text-ink">
          These confirm who you are and that the rent fits your income. They are encrypted and deleted
          twelve months after the application closes.
        </p>
      </div>

      <Card>
        <ul className="divide-y divide-line-soft">
          {REQUIRED.map((item) => (
            <li key={item.kind} className="flex items-center gap-4 px-5 py-4">
              <UploadTile
                className="w-16 shrink-0"
                src={previews[item.kind]}
                state={state[item.kind] ?? 'queued'}
                onRetry={() => capture(item.kind)}
                label={item.label}
              />
              <div className="min-w-0 flex-1">
                <p className="text-body font-semibold text-ink">{item.label}</p>
                <p className="text-meta text-ink-muted">
                  {state[item.kind] === 'synced'
                    ? pdfs[item.kind] ? 'Received (PDF)' : 'Received'
                    : state[item.kind] === 'failed'
                      ? 'Upload failed. Tap retry to choose it again.'
                      : state[item.kind] === 'uploading'
                        ? 'Uploading'
                        : 'Not uploaded yet'}
                </p>
                <p className="text-xs text-ink-muted">{item.hint}</p>
              </div>
              <input
                ref={(element) => {
                  inputs.current[item.kind] = element;
                }}
                type="file"
                accept="image/jpeg,image/png,application/pdf,.pdf"
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
                variant={state[item.kind] ? 'outline' : 'secondary'}
                size="sm"
                disabled={state[item.kind] === 'uploading'}
                aria-label={`${state[item.kind] ? 'Replace' : 'Capture'} ${item.label}`}
                onClick={() => capture(item.kind)}
              >
                {state[item.kind] ? 'Replace' : 'Capture'}
              </Button>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="mt-4">
        <CardBody className="space-y-3">
          <div>
            <h2 className="text-lead font-bold text-ink">More pages</h2>
            <p className="text-meta text-ink-muted">
              Each row above keeps one file, and a new one replaces it. If a statement or payslip runs over
              several photos, add the other pages here. Up to {MAX_EXTRA}, and they are all kept.
            </p>
          </div>
          {extras.length + extraUploads.length > 0 ? (
            <ul className="flex flex-wrap gap-2" aria-label="Extra pages on file">
              {extras.map((item, index) => (
                <li key={item.id ?? item.viewUrl}>
                  <UploadTile
                    className="w-16"
                    src={item.contentType.startsWith('image/') ? item.viewUrl : undefined}
                    state="synced"
                    label={`Extra page ${index + 1}${item.contentType === 'application/pdf' ? ' (PDF)' : ''}`}
                  />
                  <p className="mt-0.5 text-center text-xs text-ink-muted">
                    {item.contentType === 'application/pdf' ? 'PDF' : `Page ${index + 1}`}
                  </p>
                </li>
              ))}
              {extraUploads.map((entry) => (
                <li key={entry.id}>
                  <UploadTile className="w-16" src={entry.src ?? undefined} state={entry.state} label="Extra page being uploaded" />
                  <p className="mt-0.5 text-center text-xs text-ink-muted">{entry.state === 'failed' ? 'Failed' : 'Uploading'}</p>
                </li>
              ))}
            </ul>
          ) : null}
          <input
            ref={extraInput}
            type="file"
            accept="image/jpeg,image/png,application/pdf,.pdf"
            className="hidden"
            aria-label="Choose an extra page"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void uploadExtra(file);
            }}
          />
          <Button variant="outline" size="sm" disabled={extrasFull} onClick={() => extraInput.current?.click()}>
            Add another page
          </Button>
          {extras.length > 0 ? (
            <p className="text-meta text-ink-muted" role="status">
              {extras.length} extra page{extras.length === 1 ? '' : 's'} on file.
            </p>
          ) : null}
        </CardBody>
      </Card>

      {applicationId ? (
        <Card className="mt-4">
          <CardBody className="space-y-2">
            <h2 className="text-lead font-bold text-ink">Credit check</h2>
            <CreditCheckApplicant applicationId={applicationId} privacyVersion={PRIVACY_VERSION} />
          </CardBody>
        </Card>
      ) : null}
      <Button block size="lg" className="mt-5" disabled={uploading} onClick={() => navigate('/')}>
        Done
      </Button>
      <p className="mt-2 text-center text-meta text-ink-muted">
        Your application is already with the landlord. You can come back and add documents later.
      </p>
    </AuthLayout>
  );
}
