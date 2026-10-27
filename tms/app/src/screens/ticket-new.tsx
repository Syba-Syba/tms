import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router';
import { Button, Card, CardBody, PageHeader, SegmentedControl, UploadTile, useToast, type UploadState } from '@hlonie/toolbox/ui';
import { TextField } from '@hlonie/toolbox/forms';
import { useForm } from 'react-hook-form';
import { api, humanError } from '../api/client';
import { pickPhoto, putFile, type PickedPhoto } from '../lib/photos';

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
  emergency: 'Unsafe or unlivable. We respond within 24 hours.',
  urgent: 'Broken but livable. We respond within 3 days.',
  routine: 'Wear and tear. We respond within 7 days.',
} as const;

export function TicketNew() {
  const { leaseId } = useParams();
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

  const submit = handleSubmit(async (values) => {
    try {
      const ticket = await api.post<{ id: string }>(`/leases/${leaseId}/tickets`, {
        category,
        severity,
        ...values,
      });
      // Photos upload after creation so a dropped connection never loses the written report.
      let failed = 0;
      for (const [index, entry] of photos.entries()) {
        const mark = (state: UploadState) =>
          setPhotos((current) => current.map((p, i) => (i === index ? { ...p, state } : p)));
        try {
          mark('uploading');
          const { uploadUrl, photoId } = await api.post<{ uploadUrl: string; photoId: string }>(
            `/tickets/${ticket.id}/photos/presign`,
            { phase: 'report', contentType: entry.photo.contentType, sizeBytes: entry.photo.blob.size },
          );
          await putFile(uploadUrl, entry.photo.blob, entry.photo.contentType);
          await api.post('/photos/confirm', { scope: 'ticket', photoId });
          mark('synced');
        } catch {
          failed += 1;
          mark('failed');
        }
      }
      queryClient.invalidateQueries({ queryKey: ['tickets'] });
      queryClient.invalidateQueries({ queryKey: ['leases'] });
      toast.show({
        title: 'Reported',
        description: failed
          ? `${SLA_COPY[severity]} ${failed} photo${failed === 1 ? '' : 's'} did not upload; add them from the ticket.`
          : SLA_COPY[severity],
        tone: failed ? 'warning' : 'success',
      });
      navigate(-1);
    } catch (error) {
      toast.show({ title: 'Not sent', description: humanError(error), tone: 'danger' });
    }
  });

  return (
    <main className="mx-auto max-w-lg px-4 py-6">
      <PageHeader title="Report a problem" description="Photos and a clear description get it fixed faster." />
      <Card>
        <CardBody className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map((item) => (
              <Button
                key={item.value}
                size="sm"
                variant={category === item.value ? 'secondary' : 'outline'}
                onClick={() => setCategory(item.value)}
              >
                {item.label}
              </Button>
            ))}
          </div>
          <div>
            <SegmentedControl
              value={severity}
              onChange={setSeverity}
              options={[
                { label: 'Emergency', value: 'emergency' },
                { label: 'Urgent', value: 'urgent' },
                { label: 'Routine', value: 'routine' },
              ]}
            />
            <p className="mt-2 text-xs text-ink-muted">{SLA_COPY[severity]}</p>
          </div>
          <TextField control={control} name="title" label="What is it" required rules={{ required: 'A short title is needed.' }} />
          <TextField
            control={control}
            name="description"
            label="Details"
            hint="Where it is, when it started, anything a contractor should know."
            required
          />
          <div className="flex gap-2">
            {photos.map((entry, index) => (
              <UploadTile key={index} className="w-16" src={entry.photo.dataUrl} state={entry.state} />
            ))}
            <Button variant="outline" size="sm" onClick={capture}>
              Add photo
            </Button>
          </div>
          <Button block loading={formState.isSubmitting} onClick={submit}>
            Send report
          </Button>
        </CardBody>
      </Card>
    </main>
  );
}
