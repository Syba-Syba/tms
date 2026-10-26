import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import {
  Alert, Badge, Button, Card, CardBody, Combobox, CurrencyInput, Input, PageHeader, Spinner, Textarea, useToast,
} from '@hlonie/toolbox/ui';
import { api, humanError } from '../api/client';
import { Ledger } from '../components/money';
import { SignedImage } from '../components/signed-image';

interface DirectoryEntry {
  id: string;
  name: string;
  trade: string;
  phone: string;
  jobs: number;
}

interface TicketEvent {
  at: string;
  actor_role: string;
  kind: string;
  note: string | null;
}

interface Ticket {
  id: string;
  leaseId: string;
  title: string;
  description: string;
  category: string;
  severity: string;
  status: string;
  targetBy: string;
  overdue: boolean;
  unit: string;
  tenant: string;
  contractor: { name: string; trade: string | null; phone: string | null } | null;
  quoteCents: number | null;
  quoteApproved: boolean;
  rating: number | null;
  ratingNote: string | null;
  events: TicketEvent[];
  photos: { id: string; phase: 'report' | 'completion'; key: string }[];
  viewer: { isLandlord: boolean; isTenant: boolean };
}

const SEVERITY = { emergency: 'danger', urgent: 'warning', routine: 'neutral' } as const;

/** Five arches, filled to the rating. The motif does the work a star rating usually does. */
function ArchRating({ value, onChange }: { value: number; onChange?: (next: number) => void }) {
  return (
    <div className="flex gap-2.5">
      {[1, 2, 3, 4, 5].map((step) => (
        <button
          key={step}
          type="button"
          disabled={!onChange}
          onClick={() => onChange?.(step)}
          aria-label={`${step} of 5`}
          className={`h-10 w-8 rounded-t-full border-[3px] border-b-0 transition-colors ${
            step <= value ? 'border-brand-500 bg-brand-50' : 'border-line'
          }`}
        />
      ))}
    </div>
  );
}

export function TicketDetail() {
  const { ticketId } = useParams();
  const toast = useToast();
  const [quote, setQuote] = useState(0);
  const [comment, setComment] = useState('');
  const [rating, setRating] = useState(0);
  const [contractor, setContractor] = useState({ name: '', trade: '', phone: '' });

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['ticket', ticketId],
    queryFn: () => api.get<Ticket>(`/tickets/${ticketId}`),
  });

  const { data: directory } = useQuery({
    queryKey: ['contractors'],
    queryFn: () => api.get<{ items: DirectoryEntry[] }>('/contractors'),
    enabled: Boolean(data?.viewer.isLandlord),
  });

  const act = async (body: unknown, message: string) => {
    try {
      await api.post(`/tickets/${ticketId}/actions`, body);
      toast.show({ title: message, tone: 'success' });
      refetch();
    } catch (error) {
      toast.show({ title: 'That did not work', description: humanError(error), tone: 'danger' });
    }
  };

  if (isLoading || !data) return <main className="p-16 text-center"><Spinner /></main>;

  const landlord = data.viewer.isLandlord;

  return (
    <main className="mx-auto max-w-2xl px-5 py-6">
      <PageHeader
        title={data.title}
        description={`${data.unit} · ${data.category} · reported by ${data.tenant}`}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge tone={SEVERITY[data.severity as keyof typeof SEVERITY]}>{data.severity}</Badge>
        <Badge tone={data.overdue ? 'danger' : 'neutral'}>{data.status.replace(/_/g, ' ')}</Badge>
        <span className={`text-xs ${data.overdue ? 'font-bold text-danger' : 'text-ink-muted'}`}>
          {data.overdue ? 'Overdue since' : 'Response target'} {data.targetBy.slice(0, 16).replace('T', ' ')}
        </span>
      </div>

      <Card className="mb-4">
        <CardBody className="space-y-3">
          <p className="text-[14px] leading-relaxed">{data.description}</p>
          <PhotoRow photos={data.photos} phase="report" label="As reported" />
          <PhotoRow photos={data.photos} phase="completion" label="After the work" />
        </CardBody>
      </Card>

      {data.contractor ? (
        <Alert tone="info" title={`${data.contractor.name} assigned`} className="mb-4">
          {data.contractor.trade} · {data.contractor.phone}
        </Alert>
      ) : null}

      <p className="mb-2 text-[10.5px] font-bold uppercase tracking-widest text-ink-muted">History</p>
      <Card className="mb-4">
        <CardBody className="space-y-3">
          {data.events.map((entry, index) => (
            <div key={index} className="flex gap-3">
              <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand-500" />
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-semibold capitalize">
                  {entry.kind.replace(/_/g, ' ')}
                  <span className="ml-2 font-normal text-ink-muted">{entry.actor_role}</span>
                </p>
                {entry.note ? (
                  <p className="mt-1 rounded-sm bg-surface-muted px-3 py-2 text-[13px]">{entry.note}</p>
                ) : null}
                <p className="mt-0.5 font-mono text-[10px] text-ink-muted">
                  {entry.at.slice(0, 16).replace('T', ' ')}
                </p>
              </div>
            </div>
          ))}
        </CardBody>
      </Card>

      {data.quoteCents && !data.quoteApproved && landlord ? (
        <Card className="mb-4">
          <CardBody className="space-y-3">
            <p className="text-[10.5px] font-bold uppercase tracking-widest text-brand-500">Quote</p>
            <Ledger cents={data.quoteCents} className="text-[26px]" />
            <Button onClick={() => act({ action: 'approve_quote' }, 'Quote approved')}>
              Approve and let them start
            </Button>
          </CardBody>
        </Card>
      ) : null}

      {landlord && data.status === 'open' ? (
        <Card className="mb-4">
          <CardBody className="space-y-3">
            <p className="text-[15px] font-semibold">Assign a contractor</p>
            {(directory?.items ?? []).length > 0 ? (
              <div>
                <p className="mb-1 text-xs text-ink-muted">Someone you have used before</p>
                <Combobox
                  options={(directory?.items ?? []).map((entry) => ({
                    value: entry.id,
                    label: `${entry.name} · ${entry.trade} · ${entry.jobs} job${entry.jobs === 1 ? '' : 's'}`,
                  }))}
                  value={null}
                  onChange={(id) => {
                    const entry = directory?.items.find((candidate) => candidate.id === id);
                    if (entry) {
                      setContractor({ name: entry.name, trade: entry.trade, phone: entry.phone });
                    }
                  }}
                  placeholder="Search the directory"
                />
              </div>
            ) : null}
            <Input
              placeholder="Name"
              value={contractor.name}
              onChange={(e) => setContractor({ ...contractor, name: e.target.value })}
            />
            <Input
              placeholder="Trade"
              value={contractor.trade}
              onChange={(e) => setContractor({ ...contractor, trade: e.target.value })}
            />
            <Input
              placeholder="Phone"
              value={contractor.phone}
              onChange={(e) => setContractor({ ...contractor, phone: e.target.value })}
            />
            <Button
              disabled={!contractor.name || !contractor.trade || contractor.phone.length < 9}
              onClick={() => act({ action: 'assign', contractor }, 'Contractor assigned')}
            >
              Assign
            </Button>
          </CardBody>
        </Card>
      ) : null}

      {landlord && data.status === 'assigned' ? (
        <Card className="mb-4">
          <CardBody className="space-y-3">
            <p className="text-[15px] font-semibold">Add a quote, or start without one</p>
            <CurrencyInput cents={quote} onCentsChange={(next) => setQuote(next ?? 0)} />
            <div className="flex gap-2">
              <Button
                disabled={quote <= 0}
                onClick={() => act({ action: 'quote', quoteCents: quote }, 'Quote added')}
              >
                Add quote
              </Button>
              <Button variant="outline" onClick={() => act({ action: 'start' }, 'Work started')}>
                Start now
              </Button>
            </div>
          </CardBody>
        </Card>
      ) : null}

      {landlord && ['quote_approved', 'in_progress'].includes(data.status) ? (
        <Button
          className="mb-4"
          onClick={() =>
            act(
              { action: data.status === 'quote_approved' ? 'start' : 'complete' },
              data.status === 'quote_approved' ? 'Work started' : 'Marked complete',
            )
          }
        >
          {data.status === 'quote_approved' ? 'Start the work' : 'Mark complete'}
        </Button>
      ) : null}

      {data.viewer.isTenant && data.status === 'done' ? (
        <Card className="mb-4">
          <CardBody className="space-y-3">
            <p className="text-[15px] font-semibold">Rate the work to close it</p>
            <ArchRating value={rating} onChange={setRating} />
            <p className="text-xs text-ink-muted">
              Your rating follows the contractor and decides who gets called next time.
            </p>
            <Textarea
              placeholder="Anything to add"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
            <Button
              disabled={rating === 0}
              onClick={async () => {
                await api.post(`/tickets/${ticketId}/close`, { rating, note: comment || undefined });
                toast.show({ title: 'Ticket closed', tone: 'success' });
                refetch();
              }}
            >
              Close ticket
            </Button>
          </CardBody>
        </Card>
      ) : null}

      {data.rating ? (
        <Card className="mb-4">
          <CardBody className="space-y-2">
            <p className="text-[10.5px] font-bold uppercase tracking-widest text-ink-muted">Rated</p>
            <ArchRating value={data.rating} />
            {data.ratingNote ? <p className="text-[13.5px]">{data.ratingNote}</p> : null}
          </CardBody>
        </Card>
      ) : null}

      {!['closed', 'cancelled'].includes(data.status) ? (
        <Card>
          <CardBody className="space-y-3">
            <Textarea
              placeholder="Add a message to this ticket"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
            <Button
              variant="outline"
              disabled={!comment.trim()}
              onClick={async () => {
                await api.post(`/tickets/${ticketId}/comments`, { note: comment });
                setComment('');
                refetch();
              }}
            >
              Send
            </Button>
          </CardBody>
        </Card>
      ) : null}
    </main>
  );
}


function PhotoRow({ photos, phase, label }: {
  photos: Ticket['photos'];
  phase: 'report' | 'completion';
  label: string;
}) {
  const set = photos.filter((photo) => photo.phase === phase);
  if (set.length === 0) return null;
  return (
    <div>
      <p className="mb-1 text-[10.5px] font-bold uppercase tracking-widest text-ink-muted">{label}</p>
      <div className="flex flex-wrap gap-2">
        {set.map((photo) => (
          <SignedImage
            key={photo.id}
            storageKey={photo.key}
            alt={label}
            className="h-20 w-20 rounded-sm object-cover"
          />
        ))}
      </div>
    </div>
  );
}
