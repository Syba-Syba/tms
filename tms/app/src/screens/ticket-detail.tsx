import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router';
import {
  Alert, Avatar, Badge, Button, Card, CardBody, Combobox, ConfirmDialog, CurrencyInput, Input, PageHeader, Textarea,
  UploadTile, useToast, type UploadState,
} from '@hlonie/toolbox/ui';
import { api, humanError } from '../api/client';
import { Money } from '../components/money';
import { QueryState } from '../components/query-state';
import { SignedImage } from '../components/signed-image';
import { capitalise, formatDateTime, formatInstant, toIsoInstant, status } from '../lib/format';
import { pickPhoto, putFile } from '../lib/photos';
import { PAGE } from '../lib/layout';

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

/** How long a finished ticket waits for the tenant's rating before the landlord may close it.
    The server's rule (tickets-close): seven days from the moment it was marked done. */
export const LANDLORD_CLOSE_AFTER_DAYS = 7;

/** When the landlord may close a done ticket without a rating, from its own history. */
export function landlordCloseFrom(events: Pick<TicketEvent, 'at' | 'kind'>[]): Date | null {
  const completed = [...events].reverse().find((entry) => entry.kind === 'completed');
  if (!completed) return null;
  const at = new Date(toIsoInstant(completed.at));
  if (Number.isNaN(at.getTime())) return null;
  return new Date(at.getTime() + LANDLORD_CLOSE_AFTER_DAYS * 24 * 60 * 60 * 1000);
}

const EVENT_LABEL: Record<string, string> = {
  created: 'Reported',
  assigned: 'Contractor assigned',
  quote_added: 'Quote added',
  quote_approved: 'Quote approved',
  started: 'Work started',
  completed: 'Work completed',
  closed: 'Closed',
  cancelled: 'Cancelled',
  comment: 'Message',
};
const eventLabel = (kind: string) => EVENT_LABEL[kind] ?? capitalise(kind.replace(/_/g, ' '));
/** The dot on the timeline: green for progress, red for a cancellation, grey for a message. */
const eventDot = (kind: string) =>
  kind === 'cancelled' ? 'bg-danger' : kind === 'comment' ? 'bg-neutral-300' : 'bg-brand-500';

/** Five arches, filled to the rating. The motif does the work a star rating usually does.
    A radio group, so a screen reader says which rating is chosen, not just five buttons, and
    the arrow keys move through it as they do through any radio group. */
function ArchRating({ value, onChange }: { value: number; onChange?: (next: number) => void }) {
  const group = useRef<HTMLDivElement>(null);
  const choose = (next: number) => {
    onChange?.(next);
    group.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next - 1]?.focus();
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!onChange) return;
    const current = value || 0;
    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (current >= 5 ? 1 : current + 1)
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (current <= 1 ? 5 : current - 1)
      : event.key === 'Home' ? 1
      : event.key === 'End' ? 5
      : null;
    if (next === null) return;
    event.preventDefault();
    choose(next);
  };
  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label={onChange ? 'Rating' : `Rated ${value} of 5`}
      aria-readonly={onChange ? undefined : true}
      className="flex gap-2.5"
      onKeyDown={onKeyDown}
    >
      {[1, 2, 3, 4, 5].map((step) => (
        <button
          key={step}
          type="button"
          role="radio"
          aria-checked={step === value}
          disabled={!onChange}
          // One stop in the tab order, as for native radios: the chosen one, or the first.
          tabIndex={step === (value || 1) ? 0 : -1}
          onClick={() => onChange?.(step)}
          aria-label={`${step} of 5`}
          className={`h-11 w-9 rounded-t-full border-[3px] border-b-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tb-ring)] focus-visible:ring-offset-2 ${
            step <= value ? 'border-brand-500 bg-brand-100' : 'border-neutral-300 bg-surface'
          }`}
        />
      ))}
    </div>
  );
}

export function TicketDetail() {
  const { ticketId } = useParams();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [quote, setQuote] = useState(0);
  const [quoteNote, setQuoteNote] = useState('');
  const [doneNote, setDoneNote] = useState('');
  // The closing note and a message on the thread used to share one state, so typing a
  // message filled the rating note and vice versa.
  const [message, setMessage] = useState('');
  const [ratingNote, setRatingNote] = useState('');
  const [rating, setRating] = useState(0);
  const [contractor, setContractor] = useState({ name: '', trade: '', phone: '' });
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelNote, setCancelNote] = useState('');
  const [closeNote, setCloseNote] = useState('');
  // Photos of the finished work, shown here until the reloaded ticket lists them.
  const [uploads, setUploads] = useState<{ src: string; state: UploadState }[]>([]);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['ticket', ticketId],
    queryFn: () => api.get<Ticket>(`/tickets/${ticketId}`),
  });

  const { data: directory } = useQuery({
    queryKey: ['contractors'],
    queryFn: () => api.get<{ items: DirectoryEntry[] }>('/contractors'),
    enabled: Boolean(data?.viewer.isLandlord),
  });

  // One request at a time, every failure shown. The close and message buttons used to await
  // bare calls with no catch, so a refusal was an unhandled rejection and a silent button.
  const perform = async (fn: () => Promise<unknown>, title: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      toast.show({ title, tone: 'success' });
      // The list screen caches its own copy of this ticket's status.
      queryClient.invalidateQueries({ queryKey: ['tickets'] });
      queryClient.invalidateQueries({ queryKey: ['leases'] });
      refetch();
    } catch (error) {
      toast.show({ title: 'That did not work', description: humanError(error), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };
  const act = (body: unknown, message: string) =>
    perform(() => api.post(`/tickets/${ticketId}/actions`, body), message);

  /** A photo of the finished work: uploaded as soon as it is chosen, then confirmed. */
  const addCompletionPhoto = async () => {
    let photo: Awaited<ReturnType<typeof pickPhoto>>;
    try {
      photo = await pickPhoto();
    } catch (error) {
      toast.show({ title: 'Could not read that photo', description: humanError(error), tone: 'danger' });
      return;
    }
    if (!photo) return;
    const src = photo.dataUrl;
    const mark = (state: UploadState) =>
      setUploads((current) => current.map((entry) => (entry.src === src ? { ...entry, state } : entry)));
    setUploads((current) => [...current, { src, state: 'uploading' }]);
    try {
      const { uploadUrl, photoId } = await api.post<{ uploadUrl: string; photoId: string }>(
        `/tickets/${ticketId}/photos/presign`,
        { phase: 'completion', contentType: photo.contentType, sizeBytes: photo.blob.size },
      );
      await putFile(uploadUrl, photo.blob, photo.contentType);
      await api.post('/photos/confirm', { scope: 'ticket', photoId });
    } catch (error) {
      mark('failed');
      toast.show({ title: 'Photo not uploaded', description: humanError(error), tone: 'danger' });
      return;
    }
    // Shown from the ticket once it reloads; keeping the local tile too would show it twice.
    await refetch();
    setUploads((current) => current.filter((entry) => entry.src !== src));
  };

  if (!data) {
    return <QueryState isLoading={isLoading} isError={isError} error={error} onRetry={refetch} what="This ticket" />;
  }

  const landlord = data.viewer.isLandlord;
  const ended = ['closed', 'cancelled'].includes(data.status);
  const cancellable = landlord && ['open', 'assigned', 'quote_pending', 'quote_approved', 'in_progress'].includes(data.status);
  const closeFrom = landlordCloseFrom(data.events);
  const landlordMayClose = landlord && data.status === 'done' && closeFrom !== null && closeFrom.getTime() <= Date.now();

  const PhotoAdder = (
    <div>
      <p className="mb-1.5 text-meta font-semibold text-ink">Photos of the finished work</p>
      <div className="flex flex-wrap items-center gap-2">
        {uploads.map((entry) => (
          <UploadTile key={entry.src} className="w-20" src={entry.src} state={entry.state} label="Photo of the finished work" />
        ))}
        <Button size="sm" variant="outline" onClick={addCompletionPhoto}>
          Add a photo of the work
        </Button>
      </div>
    </div>
  );

  return (
    <main className={PAGE.wide}>
      <PageHeader
        title={data.title}
        description={`${data.unit} · ${capitalise(data.category)} · reported by ${data.tenant}`}
      />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Badge tone={SEVERITY[data.severity as keyof typeof SEVERITY]}>{capitalise(data.severity)}</Badge>
        <Badge tone={data.overdue ? 'danger' : status(data.status).tone}>{status(data.status).label}</Badge>
        {['done', 'closed', 'cancelled'].includes(data.status) ? null : (
          <span className={`text-meta ${data.overdue ? 'font-bold text-danger' : 'text-ink-muted'}`}>
            {data.overdue ? 'Overdue since' : 'Response target'} {formatDateTime(data.targetBy)}
          </span>
        )}
      </div>

      {/* On a laptop the next step and the people sit beside the story; on a phone the next
          step comes straight after what was reported. */}
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card>
          <CardBody className="space-y-4">
            <h2 className="text-lead font-bold text-ink">What was reported</h2>
            <p className="whitespace-pre-line text-body leading-relaxed text-ink">{data.description}</p>
            <PhotoRow photos={data.photos} phase="report" label="As reported" />
            <PhotoRow photos={data.photos} phase="completion" label="After the work" />
          </CardBody>
        </Card>

        <div className="space-y-4 lg:row-span-2">
          {data.status === 'cancelled' ? (
            <Alert tone="warning" title="This repair was cancelled">
              Nothing more happens on it. Its history is kept below.
            </Alert>
          ) : null}

          {data.quoteCents && !data.quoteApproved && landlord && data.status === 'quote_pending' ? (
            <Card>
              <CardBody className="space-y-3">
                <h2 className="text-lead font-bold text-ink">Quote to approve</h2>
                <Money cents={data.quoteCents} className="block text-figure text-ink" />
                <Button block loading={busy} onClick={() => act({ action: 'approve_quote' }, 'Quote approved')}>
                  Approve and let them start
                </Button>
              </CardBody>
            </Card>
          ) : null}

          {landlord && data.status === 'open' ? (
            <Card>
              <CardBody className="space-y-3">
                <h2 className="text-lead font-bold text-ink">Assign a contractor</h2>
                {(directory?.items ?? []).length > 0 ? (
                  <div>
                    <p className="mb-1 text-meta text-ink-muted">Someone you have used before</p>
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
                  aria-label="Contractor name"
                  placeholder="Name"
                  value={contractor.name}
                  onChange={(e) => setContractor({ ...contractor, name: e.target.value })}
                />
                <Input
                  aria-label="Contractor trade"
                  placeholder="Trade"
                  value={contractor.trade}
                  onChange={(e) => setContractor({ ...contractor, trade: e.target.value })}
                />
                <Input
                  aria-label="Contractor phone"
                  placeholder="Phone"
                  value={contractor.phone}
                  onChange={(e) => setContractor({ ...contractor, phone: e.target.value })}
                />
                <Button
                  block
                  loading={busy}
                  disabled={!contractor.name || !contractor.trade || contractor.phone.length < 9}
                  onClick={() => act({ action: 'assign', contractor }, 'Contractor assigned')}
                >
                  Assign
                </Button>
              </CardBody>
            </Card>
          ) : null}

          {landlord && data.status === 'assigned' ? (
            <Card>
              <CardBody className="space-y-3">
                <h2 className="text-lead font-bold text-ink">Add a quote, or start without one</h2>
                <CurrencyInput aria-label="Quote amount" cents={quote} onCentsChange={(next) => setQuote(next ?? 0)} />
                <Input
                  aria-label="Note on the quote"
                  placeholder="What the quote covers (optional)"
                  maxLength={500}
                  value={quoteNote}
                  onChange={(e) => setQuoteNote(e.target.value)}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    loading={busy}
                    disabled={quote <= 0}
                    onClick={() =>
                      act({ action: 'quote', quoteCents: quote, note: quoteNote.trim() || undefined }, 'Quote added')
                    }
                  >
                    Add quote
                  </Button>
                  <Button variant="outline" disabled={busy} onClick={() => act({ action: 'start' }, 'Work started')}>
                    Start now
                  </Button>
                </div>
              </CardBody>
            </Card>
          ) : null}

          {landlord && data.status === 'quote_approved' ? (
            <Card>
              <CardBody className="space-y-3">
                <h2 className="text-lead font-bold text-ink">The quote is approved</h2>
                <p className="text-body text-ink-muted">Mark the work as started once the contractor is on site.</p>
                <Button block loading={busy} onClick={() => act({ action: 'start' }, 'Work started')}>
                  Start the work
                </Button>
              </CardBody>
            </Card>
          ) : null}

          {landlord && data.status === 'in_progress' ? (
            <Card>
              <CardBody className="space-y-3">
                <h2 className="text-lead font-bold text-ink">When the work is finished</h2>
                <Textarea
                  aria-label="What was done"
                  placeholder="What was done (optional). The tenant sees this."
                  rows={2}
                  maxLength={1000}
                  value={doneNote}
                  onChange={(e) => setDoneNote(e.target.value)}
                />
                {PhotoAdder}
                <Button
                  block
                  loading={busy}
                  disabled={uploads.some((entry) => entry.state === 'uploading')}
                  onClick={() => act({ action: 'complete', note: doneNote.trim() || undefined }, 'Marked complete')}
                >
                  Mark complete
                </Button>
              </CardBody>
            </Card>
          ) : null}

          {landlord && data.status === 'done' ? (
            <Card>
              <CardBody className="space-y-3">
                <h2 className="text-lead font-bold text-ink">Waiting for {data.tenant} to rate the work</h2>
                {landlordMayClose ? (
                  <>
                    <p className="text-body text-ink-muted">
                      It has been done for more than {LANDLORD_CLOSE_AFTER_DAYS} days with no rating, so you can close it yourself.
                      The contractor gets no rating for this job.
                    </p>
                    <Input
                      aria-label="Closing note"
                      placeholder="Closing note (optional)"
                      maxLength={1000}
                      value={closeNote}
                      onChange={(e) => setCloseNote(e.target.value)}
                    />
                    <Button
                      block
                      loading={busy}
                      onClick={() =>
                        perform(
                          () => api.post(`/tickets/${ticketId}/close`, { note: closeNote.trim() || undefined }),
                          'Ticket closed',
                        )
                      }
                    >
                      Close without a rating
                    </Button>
                  </>
                ) : (
                  <p className="text-body text-ink-muted">
                    The tenant closes it by rating the work. If they have not
                    {closeFrom ? ` by ${formatInstant(closeFrom.toISOString())}` : ` after ${LANDLORD_CLOSE_AFTER_DAYS} days`},
                    you can close it yourself here.
                  </p>
                )}
                {PhotoAdder}
              </CardBody>
            </Card>
          ) : null}

          {!landlord && !ended && data.status !== 'done' ? (
            <Card>
              <CardBody className="space-y-1">
                <h2 className="text-lead font-bold text-ink">
                  {data.status === 'open'
                    ? 'Your landlord has been told'
                    : data.status === 'in_progress'
                      ? 'The work has started'
                      : 'A contractor has been assigned'}
                </h2>
                <p className="text-body text-ink-muted">
                  {data.status === 'open'
                    ? 'They assign a contractor next. You are told when they do.'
                    : data.status === 'in_progress'
                      ? 'When it is finished you rate the work, and that closes it.'
                      : 'They will be in touch to arrange a time. Add a message below if anything changes.'}
                </p>
              </CardBody>
            </Card>
          ) : null}

          {data.viewer.isTenant && data.status === 'done' ? (
            <Card className="border-brand-500/40">
              <CardBody className="space-y-3">
                <h2 className="text-lead font-bold text-ink">Rate the work to close it</h2>
                <ArchRating value={rating} onChange={setRating} />
                <p className="text-meta text-ink-muted">
                  Your rating follows the contractor and decides who gets called next time.
                </p>
                <Textarea
                  aria-label="Anything to add"
                  placeholder="Anything to add"
                  value={ratingNote}
                  onChange={(e) => setRatingNote(e.target.value)}
                />
                <Button
                  block
                  loading={busy}
                  disabled={rating === 0}
                  onClick={() =>
                    perform(
                      () => api.post(`/tickets/${ticketId}/close`, { rating, note: ratingNote.trim() || undefined }),
                      'Ticket closed',
                    )
                  }
                >
                  Close ticket
                </Button>
              </CardBody>
            </Card>
          ) : null}

          {data.rating ? (
            <Card>
              <CardBody className="space-y-2">
                <h2 className="text-lead font-bold text-ink">Rated</h2>
                <ArchRating value={data.rating} />
                {data.ratingNote ? <p className="text-body text-ink">{data.ratingNote}</p> : null}
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <h2 className="px-5 pb-1 pt-4 text-lead font-bold text-ink">Who is involved</h2>
            <ul className="divide-y divide-line-soft">
              <li className="flex items-center gap-3 px-5 py-3.5">
                <Avatar name={data.tenant} />
                <div className="min-w-0">
                  <p className="truncate text-body font-semibold text-ink">{data.tenant}</p>
                  <p className="truncate text-meta text-ink-muted">Tenant, {data.unit}</p>
                </div>
              </li>
              {data.contractor ? (
                <li className="flex items-center gap-3 px-5 py-3.5">
                  <Avatar name={data.contractor.name} tone="info" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-body font-semibold text-ink">{data.contractor.name} assigned</p>
                    <p className="truncate text-meta text-ink-muted">
                      {data.contractor.trade} · {data.contractor.phone}
                    </p>
                  </div>
                  {data.contractor.phone ? (
                    <a
                      href={`tel:${data.contractor.phone.replace(/\s+/g, '')}`}
                      aria-label={`Call ${data.contractor.name}`}
                      className="inline-flex h-9 items-center rounded-sm border border-neutral-300 bg-surface px-3.5 text-meta font-semibold text-ink hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tb-ring)] focus-visible:ring-offset-2"
                    >
                      Call
                    </a>
                  ) : null}
                </li>
              ) : (
                <li className="px-5 py-3.5 text-meta text-ink-muted">No contractor assigned yet.</li>
              )}
              {data.quoteCents ? (
                <li className="flex items-center justify-between gap-3 px-5 py-3.5">
                  <span className="text-body text-ink">Quote</span>
                  <span className="flex items-center gap-2">
                    <Money cents={data.quoteCents} className="text-body text-ink" />
                    <Badge tone={data.quoteApproved ? 'success' : 'warning'}>{data.quoteApproved ? 'Approved' : 'Not approved yet'}</Badge>
                  </span>
                </li>
              ) : null}
            </ul>
          </Card>

          {cancellable ? (
            <Button block variant="outline" disabled={busy} onClick={() => setCancelling(true)}>
              Cancel this repair
            </Button>
          ) : null}
        </div>

        <div className="space-y-4">
          <Card>
            <h2 className="px-5 pb-1 pt-4 text-lead font-bold text-ink">What has happened</h2>
            <ol className="px-5 pb-4 pt-2">
              {data.events.map((entry, index) => (
                <li key={index} className="relative flex gap-3.5 pb-5 last:pb-0">
                  {index < data.events.length - 1 ? (
                    <span aria-hidden className="absolute left-[5px] top-4 h-full w-px bg-line" />
                  ) : null}
                  <span aria-hidden className={`relative mt-1.5 h-[11px] w-[11px] shrink-0 rounded-full ${eventDot(entry.kind)}`} />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-baseline gap-x-2 text-body font-semibold text-ink">
                      {eventLabel(entry.kind)}
                      <span className="text-meta font-normal text-ink-muted">by the {entry.actor_role}</span>
                    </p>
                    {entry.note ? (
                      <p className="mt-1.5 whitespace-pre-line rounded-sm bg-surface-muted px-3 py-2 text-body text-ink">{entry.note}</p>
                    ) : null}
                    <p className="mt-1 text-xs text-ink-muted">
                      {/* at::text is UTC; sliced as written it was two hours behind for everyone. */}
                      {formatDateTime(entry.at)}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </Card>

          {!ended ? (
            <Card>
              <CardBody className="space-y-3">
                <h2 className="text-lead font-bold text-ink">Add a message</h2>
                <Textarea
                  aria-label="Message"
                  placeholder="Add a message to this ticket"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                />
                <Button
                  variant="secondary"
                  loading={busy}
                  disabled={!message.trim()}
                  onClick={() =>
                    perform(async () => {
                      await api.post(`/tickets/${ticketId}/comments`, { note: message.trim() });
                      setMessage('');
                    }, 'Message sent')
                  }
                >
                  Send
                </Button>
              </CardBody>
            </Card>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        open={cancelling}
        onOpenChange={(next) => !busy && setCancelling(next)}
        title="Cancel this repair?"
        description="It leaves the open list and nothing more happens on it. The history is kept. Use this for a duplicate, or a problem that sorted itself out."
        confirmLabel="Cancel the repair"
        loading={busy}
        onConfirm={async () => {
          await act({ action: 'cancel', note: cancelNote.trim() || undefined }, 'Repair cancelled');
          setCancelling(false);
        }}
      >
        <Textarea
          aria-label="Why it is cancelled"
          placeholder="Why it is cancelled (optional). The tenant sees this."
          rows={2}
          maxLength={500}
          value={cancelNote}
          onChange={(e) => setCancelNote(e.target.value)}
        />
      </ConfirmDialog>
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
      <p className="mb-1.5 text-meta font-semibold text-ink">{label}</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {set.map((photo, index) => (
          <SignedImage
            key={photo.id}
            storageKey={photo.key}
            alt={`${label}, photo ${index + 1}`}
            className="aspect-[4/3] w-full rounded-sm border border-line object-cover"
          />
        ))}
      </div>
    </div>
  );
}
