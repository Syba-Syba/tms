import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Avatar, Badge, Button, Modal, Textarea, useToast } from '@hlonie/toolbox/ui';
import { SettingsCard } from './settings-nav';
import { api, humanError } from '../api/client';
import { formatInstant } from '../lib/format';
import { useLandlord } from '../lib/landlord';

export interface PrivacyRequest {
  id: string;
  name: string;
  email: string | null;
  note: string | null;
  status: 'pending' | 'completed' | 'refused';
  createdAt: string;
  response: string | null;
  blockedBecause: string | null;
}

/**
 * The landlord's side of POPIA erasure. The landlord is the responsible party, so they answer,
 * but the retention rule is the system's: Erase is only offered when the law allows it.
 */
export function PrivacyRequests() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({
    queryKey: ['privacy-requests'],
    queryFn: () => api.get<{ items: PrivacyRequest[] }>('/privacy-requests'),
  });
  const [confirming, setConfirming] = useState<PrivacyRequest | null>(null);
  const [refusing, setRefusing] = useState<{ request: PrivacyRequest; response: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // The server lets only the owner answer, so an agent is not offered buttons that are refused.
  const isOwner = useLandlord().data?.me.role === 'owner';

  const decide = async (id: string, body: Record<string, unknown>, done: string) => {
    setBusy(true);
    try {
      await api.post(`/privacy-requests/${id}/decision`, body);
      await queryClient.invalidateQueries({ queryKey: ['privacy-requests'] });
      setConfirming(null);
      setRefusing(null);
      toast.show({ title: done, tone: 'success' });
    } catch (error) {
      toast.show({ title: 'Not saved', description: humanError(error), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const items = data?.items ?? [];
  return (
    <>
      <SettingsCard
        title="Privacy requests"
        description="Requests to erase personal information. The account owner answers them."
        action={items.some((request) => request.status === 'pending') ? <Badge tone="warning">To answer</Badge> : null}
      >
        {items.length === 0 ? (
          <p className="text-body text-ink-muted">
            None. When a tenant or applicant asks for their information to be erased, it appears here.
          </p>
        ) : (
          <ul className="-mx-5 -mb-5 divide-y divide-line-soft border-t border-line-soft">
            {items.map((request) => (
              <li key={request.id} className="space-y-2.5 px-5 py-4">
                <div className="flex items-start gap-3">
                  <Avatar name={request.name} tone={request.status === 'pending' ? 'warning' : undefined} />
                  <div className="min-w-0 flex-1">
                    <p className="text-body font-semibold text-ink">{request.name}</p>
                    <p className="truncate text-meta text-ink-muted">{request.email ? `${request.email}, ` : ''}asked {formatInstant(request.createdAt)}</p>
                  </div>
                  <Badge tone={request.status === 'pending' ? 'warning' : request.status === 'completed' ? 'success' : 'neutral'}>
                    {request.status === 'pending' ? 'To answer' : request.status === 'completed' ? 'Erased' : 'Refused'}
                  </Badge>
                </div>
                {request.note ? <p className="rounded-sm bg-surface-muted px-3 py-2 text-meta text-ink">"{request.note}"</p> : null}
                {request.status === 'pending' && !isOwner ? (
                  <p className="text-meta text-ink-muted">Only the account owner can answer this request.</p>
                ) : request.status === 'pending' ? (
                  <>
                    {request.blockedBecause ? (
                      <p className="text-meta text-ink-muted">
                        Their records must still be kept, so erasing is not allowed yet. Refuse with the reason below.
                      </p>
                    ) : (
                      <p className="text-meta text-ink-muted">Nothing requires you to keep their records. Erase them.</p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {!request.blockedBecause ? (
                        <Button size="sm" variant="danger" onClick={() => setConfirming(request)}>Erase</Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setRefusing({ request, response: request.blockedBecause ?? '' })}
                      >
                        Refuse with reason
                      </Button>
                    </div>
                  </>
                ) : request.response ? (
                  <p className="text-meta text-ink-muted">{request.response}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </SettingsCard>

      <Modal
        open={Boolean(confirming)}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={confirming ? `Erase ${confirming.name}` : 'Erase'}
      >
        {confirming ? (
          <div className="space-y-4">
            <Alert tone="warning" title="This cannot be undone">
              Their name, contact details, ID and income are replaced, their documents and account are deleted,
              and they are emailed to say it is done. Your rent and lease records keep their amounts and dates.
            </Alert>
            <Button
              block
              variant="danger"
              loading={busy}
              onClick={() => decide(confirming.id, { decision: 'erase' }, 'Information erased')}
            >
              Erase their information
            </Button>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(refusing)}
        onOpenChange={(open) => !open && setRefusing(null)}
        title="Refuse with a reason"
        description="They are emailed this, with how to complain to the Information Regulator."
      >
        {refusing ? (
          <div className="space-y-4">
            <Textarea
              aria-label="Reason"
              maxLength={1000}
              value={refusing.response}
              onChange={(event) => setRefusing({ ...refusing, response: event.target.value })}
            />
            <Button
              block
              loading={busy}
              disabled={refusing.response.trim().length < 10}
              onClick={() =>
                decide(refusing.request.id, { decision: 'refuse', response: refusing.response.trim() }, 'Answer sent')
              }
            >
              Send
            </Button>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
