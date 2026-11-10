import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router';
import { Button, Card, CardBody, PageHeader, UploadTile, useToast, type UploadState } from '@hlonie/toolbox/ui';
import { TextAreaField, TextField } from '@hlonie/toolbox/forms';
import { useForm } from 'react-hook-form';
import { api, humanError } from '../api/client';
import { pickPhoto, putFile, type PickedPhoto } from '../lib/photos';
import { uploadPending } from '../lib/uploads';
import { ChoiceGroup } from '../components/choice-group';
import { isLandlord } from '../lib/session';
import { PAGE } from '../lib/layout';

const CATEGORIES = [
  { value: 'plumbing', label: 'Plumbing' },
  { value: 'electrical', label: 'Electrical' },
  { value: 'appliance', label: 'Appliance' },
  { value: 'structural', label: 'Structural' },
  { value: 'pest', label: 'Pests' },
  { value: 'security', label: 'Security' },
  { value: 'other', label: 'Other' },
] as const;

const SLA_COPY = {
  emergency: 'Unsafe or unlivable. To be seen to within 24 hours.',
  urgent: 'Broken but livable. To be seen to within 3 days.',
  routine: 'Wear and tear. To be seen to within 7 days.',
} as const;

export function TicketNew() {
  const { leaseId } = useParams();
  const landlord = isLandlord();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { control, handleSubmit, formState } = useForm<{ title: string; description: string }>();
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]['value']>('plumbing');
  const [severity, setSeverity] = useState<keyof typeof SLA_COPY>('routine');
  const [photos, setPhotos] = useState<{ photo: PickedPhoto; state: UploadState }[]>([]);

  const capture = async () => {
    try {
      const photo = await pickPhoto();
      if (photo) setPhotos((current) => [...current, { photo, state: 'queued' }]);
    } catch (error) {
      toast.show({ title: 'Could not read that photo', description: humanError(error), tone: 'danger' });
    }
  };

  // Set once the report is in. A photo that failed stays here to retry: the ticket screen
  // cannot add photos, so leaving would lose it.
  const [ticketId, setTicketId] = useState<string | null>(null);

  const uploadPhotos = async (id: string) =>
    uploadPending(
      photos,
      async (entry) => {
        const { uploadUrl, photoId } = await api.post<{ uploadUrl: string; photoId: string }>(
          `/tickets/${id}/photos/presign`,
          { phase: 'report', contentType: entry.photo.contentType, sizeBytes: entry.photo.blob.size },
        );
        await putFile(uploadUrl, entry.photo.blob, entry.photo.contentType);
        await api.post('/photos/confirm', { scope: 'ticket', photoId });
      },
      (index, state) => setPhotos((current) => current.map((p, i) => (i === index ? { ...p, state } : p))),
    );

  const finish = (id: string, failed: number) => {
    queryClient.invalidateQueries({ queryKey: ['tickets'] });
    queryClient.invalidateQueries({ queryKey: ['leases'] });
    if (failed) {
      setTicketId(id);
      toast.show({
        title: 'Reported',
        description: `${failed} photo${failed === 1 ? '' : 's'} did not upload. Retry here, or finish without ${failed === 1 ? 'it' : 'them'}.`,
        tone: 'warning',
      });
      return;
    }
    toast.show({ title: ticketId ? 'Photos added' : 'Reported', description: SLA_COPY[severity], tone: 'success' });
    navigate(-1);
  };

  const submit = handleSubmit(async (values) => {
    if (ticketId) {
      finish(ticketId, await uploadPhotos(ticketId));
      return;
    }
    try {
      const ticket = await api.post<{ id: string }>(`/leases/${leaseId}/tickets`, {
        category,
        severity,
        ...values,
      });
      // Photos upload after creation so a dropped connection never loses the written report.
      finish(ticket.id, await uploadPhotos(ticket.id));
    } catch (error) {
      toast.show({ title: 'Not sent', description: humanError(error), tone: 'danger' });
    }
  });

  return (
    <main className={PAGE.wide}>
      <PageHeader title="Report a problem" description="Photos and a clear description get it fixed faster." />
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card>
          <CardBody className="space-y-5">
            <div>
              <p className="mb-2 text-body font-semibold text-ink">What kind of problem is it?</p>
              <ChoiceGroup label="Category" options={[...CATEGORIES]} value={category} onChange={setCategory} />
            </div>
            <div>
              <p className="mb-2 text-body font-semibold text-ink">How serious is it?</p>
              <ChoiceGroup
                label="How serious"
                layout="cards"
                value={severity}
                onChange={setSeverity}
                options={[
                  { label: 'Emergency', value: 'emergency', hint: 'Unsafe or unlivable', tone: 'danger' },
                  { label: 'Urgent', value: 'urgent', hint: 'Broken but livable', tone: 'warning' },
                  { label: 'Routine', value: 'routine', hint: 'Wear and tear' },
                ]}
              />
              <p className="mt-2 text-meta text-ink-muted" aria-live="polite">{SLA_COPY[severity]}</p>
            </div>
            <TextField control={control} name="title" label="What is it" required rules={{ required: 'A short title is needed.' }} />
            <TextAreaField
              control={control}
              name="description"
              label="Details"
              hint="Where it is, when it started, anything a contractor should know."
              required
            />
            <div>
              <p className="mb-2 text-body font-semibold text-ink">Photos</p>
              <div className="flex flex-wrap items-center gap-2">
                {photos.map((entry, index) => (
                  <UploadTile key={index} className="w-20" src={entry.photo.dataUrl} state={entry.state} label={`Photo ${index + 1} of the problem`} />
                ))}
                <Button variant="outline" size="sm" onClick={capture}>
                  Add photo
                </Button>
              </div>
            </div>
            <Button block size="lg" loading={formState.isSubmitting} onClick={submit}>
              {ticketId ? 'Retry photos' : 'Send report'}
            </Button>
            {ticketId ? (
              <Button block variant="outline" disabled={formState.isSubmitting} onClick={() => navigate(-1)}>
                Finish without them
              </Button>
            ) : null}
          </CardBody>
        </Card>

        <aside className="space-y-4">
          <div className="rounded-md bg-brand-50 px-5 py-5">
            <h2 className="text-lead font-bold text-ink">What happens next</h2>
            <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-body text-ink">
              <li>{landlord ? 'The repair is logged against the unit and the tenant can follow it.' : 'Your landlord is told straight away.'}</li>
              <li>A contractor is assigned, and you see who and when.</li>
              <li>When the work is done, the tenant rates it and that closes it.</li>
            </ol>
          </div>
          <Card>
            <CardBody className="space-y-2">
              <h2 className="text-lead font-bold text-ink">Is someone in danger?</h2>
              <p className="text-body text-ink-muted">
                For a fire, a gas smell or a burst pipe that is flooding, phone the emergency services or your landlord
                first, then report it here so there is a record.
              </p>
            </CardBody>
          </Card>
        </aside>
      </div>
    </main>
  );
}
