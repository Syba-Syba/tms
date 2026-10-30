import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Alert, Badge, Button, Card, CardBody, Modal, Textarea, useToast } from '@hlonie/toolbox/ui';
import { api, humanError } from '../api/client';
import { endSession, isLandlord } from '../lib/session';
import { formatInstant } from '../lib/format';

interface PrivacyState {
  acceptedVersion: string | null;
  acceptedAt: string | null;
  erasureBlockedBecause: string | null;
  requests: { id: string; status: 'pending' | 'completed' | 'refused'; createdAt: string; response: string | null; landlord: string | null }[];
}

const REQUEST_LABEL = {
  pending: { label: 'Waiting for your landlord', tone: 'info' },
  completed: { label: 'Done', tone: 'success' },
  refused: { label: 'Not carried out', tone: 'warning' },
} as const;

/** POPIA rights, where people look for them: see everything held about you, or ask for it to go. */
export function YourData() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['privacy'], queryFn: () => api.get<PrivacyState>('/me/privacy') });
  const [downloading, setDownloading] = useState(false);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const landlord = isLandlord();
  const pending = data?.requests.find((request) => request.status === 'pending');

  const download = async () => {
    setDownloading(true);
    try {
      const exported = await api.get<unknown>('/me/data-export');
      const url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `my-data-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.show({ title: 'Download failed', description: humanError(error), tone: 'danger' });
    } finally {
      setDownloading(false);
    }
  };

  const requestErasure = async () => {
    setBusy(true);
    try {
      const result = await api.post<{ status: 'pending' | 'completed' }>('/me/erasure-request', {
        note: note.trim() || undefined,
      });
      if (result.status === 'completed') {
        toast.show({ title: 'Your account is deleted', tone: 'success' });
        await endSession();
        return;
      }
      setAsking(false);
      setNote('');
      await queryClient.invalidateQueries({ queryKey: ['privacy'] });
      toast.show({ title: 'Request sent', description: 'Each landlord answers for their own records, and you are emailed either way.', tone: 'success' });
    } catch (error) {
      toast.show({ title: 'Request not sent', description: humanError(error), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2 className="label mb-2">Your data</h2>
      <Card>
        <CardBody className="space-y-4">
          <p className="text-body text-ink-muted">
            {data?.acceptedAt
              ? `You agreed to the privacy notice on ${formatInstant(data.acceptedAt)}. `
              : ''}
            <Link to="/privacy" className="font-bold text-brand-500">Read the privacy notice</Link>
          </p>
          <div>
            <Button variant="outline" loading={downloading} onClick={download}>Download my data</Button>
            <p className="mt-1 text-xs text-ink-muted">Everything this app holds about you, in one file.</p>
          </div>
          {!landlord ? (
            <div>
              {pending ? (
                <Alert tone="info" title="Erasure requested">
                  Sent {formatInstant(pending.createdAt)}. Each landlord you applied to or rented from answers for their own records, and you are emailed either way.
                </Alert>
              ) : (
                <>
                  <Button variant="ghost" onClick={() => setAsking(true)}>Erase my information</Button>
                  <p className="mt-1 text-xs text-ink-muted">Ask for your personal information to be deleted.</p>
                </>
              )}
            </div>
          ) : null}
          {data?.requests.filter((request) => request.status !== 'pending').map((request) => (
            <div key={request.id} className="space-y-1 border-t border-line-soft pt-3">
              <p className="flex items-center gap-2 text-meta">
                Erasure request of {formatInstant(request.createdAt)}{request.landlord ? ` to ${request.landlord}` : ''}
                <Badge tone={REQUEST_LABEL[request.status].tone}>{REQUEST_LABEL[request.status].label}</Badge>
              </p>
              {request.response ? <p className="text-xs text-ink-muted">{request.response}</p> : null}
            </div>
          ))}
        </CardBody>
      </Card>

      <Modal open={asking} onOpenChange={setAsking} title="Erase my information">
        <div className="space-y-3">
          {data?.erasureBlockedBecause ? (
            <Alert tone="warning" title="Some of it has to be kept for now">
              {data.erasureBlockedBecause}
            </Alert>
          ) : (
            <p className="text-body text-ink-muted">
              Your landlord is asked to erase your name, contact details, ID and income, and to delete your
              documents and your account. You are signed out when it is done, and cannot undo it.
            </p>
          )}
          <Textarea
            placeholder="Anything your landlord should know (optional)"
            maxLength={1000}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <Button block variant="danger" loading={busy} onClick={requestErasure}>
            Send the request
          </Button>
        </div>
      </Modal>
    </section>
  );
}
