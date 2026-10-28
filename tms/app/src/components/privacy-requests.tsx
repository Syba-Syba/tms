import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardBody, Modal, Textarea, useToast } from '@hlonie/toolbox/ui';
import { api, humanError } from '../api/client';
import { formatDate } from '../lib/format';

export interface PrivacyRequest {
  id: string;
  name: string;
  email: string;
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
    <section>
      <h2 className="label mb-2">Privacy requests</h2>
      {items.length === 0 ? (
        <Card>
          <CardBody>
            <p className="text-[14px] text-ink-muted">
              None. When a tenant or applicant asks for their information to be erased, it appears here.
            </p>
          </CardBody>
        </Card>
      ) : (
        <div className="space-y-3">
          {items.map((request) => (
            <Card key={request.id}>
              <CardBody className="space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[15px] font-semibold">{request.name}</p>
                    <p className="truncate text-xs text-ink-muted">{request.email}, asked {formatDate(request.createdAt)}</p>
                  </div>
                  <Badge tone={request.status === 'pending' ? 'warning' : request.status === 'completed' ? 'success' : 'neutral'}>
                    {request.status === 'pending' ? 'To answer' : request.status === 'completed' ? 'Erased' : 'Refused'}
                  </Badge>
                </div>
                {request.note ? <p className="text-[13px] text-ink">"{request.note}"</p> : null}
                {request.status === 'pending' ? (
                  <>
                    {request.blockedBecause ? (
                      <p className="text-xs text-ink-muted">
                        Their records must still be kept, so erasing is not allowed yet. Refuse with the reason below.
                      </p>
                    ) : (
                      <p className="text-xs text-ink-muted">Nothing requires you to keep their records. Erase them.</p>
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
                  <p className="text-xs text-ink-muted">{request.response}</p>
                ) : null}
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={Boolean(confirming)}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={confirming ? `Erase ${confirming.name}` : 'Erase'}
      >
        {confirming ? (
          <div className="space-y-3">
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
          <div className="space-y-3">
            <Textarea
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
    </section>
  );
}
