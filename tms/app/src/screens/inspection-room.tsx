import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router';
import {
  Button, Card, CardBody, PageHeader, SegmentedControl, Textarea, UploadTile, useToast,
  type UploadState,
} from '@hlonie/toolbox/ui';
import { api, humanError } from '../api/client';
import { QueryState } from '../components/query-state';
import { SignedImage } from '../components/signed-image';
import { pickPhoto, putFile } from '../lib/photos';
import type { InspectionState } from './inspection-rooms';

type Condition = 'good' | 'fair' | 'poor' | 'damaged' | 'missing';

export function InspectionRoom() {
  const { inspectionId, room = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [conditions, setConditions] = useState<Record<string, Condition>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [photos, setPhotos] = useState<Record<string, { src: string; state: UploadState }>>({});
  const [saving, setSaving] = useState(false);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['inspection', inspectionId],
    queryFn: () => api.get<InspectionState>(`/inspections/${inspectionId}`),
  });

  const findings = (data?.findings ?? []).filter((finding) => finding.room === room);
  const locked = data ? data.status !== 'in_progress' : true;

  // What was recorded last time is the starting point, not a blank slate.
  useEffect(() => {
    if (!data) return;
    setConditions(
      Object.fromEntries(findings.map((finding) => [finding.item, finding.condition as Condition])),
    );
    setNotes(Object.fromEntries(findings.map((finding) => [finding.item, finding.note ?? ''])));
  }, [data?.id, room]);

  const capture = async (item: string) => {
    let photo: Awaited<ReturnType<typeof pickPhoto>>;
    try {
      photo = await pickPhoto();
    } catch (error) {
      toast.show({ title: 'Could not read that photo', description: humanError(error), tone: 'danger' });
      return;
    }
    if (!photo) return;
    setPhotos((current) => ({ ...current, [item]: { src: photo.dataUrl, state: 'uploading' } }));
    try {
      const { uploadUrl, photoId } = await api.post<{ uploadUrl: string; photoId: string }>(
        `/inspections/${inspectionId}/photos/presign`,
        { room, item, contentType: photo.contentType, sizeBytes: photo.blob.size },
      );
      await putFile(uploadUrl, photo.blob, photo.contentType);
      // The server only puts confirmed photos in the sealed report.
      await api.post('/photos/confirm', { scope: 'inspection', photoId });
      setPhotos((current) => ({ ...current, [item]: { src: photo.dataUrl, state: 'synced' } }));
      queryClient.invalidateQueries({ queryKey: ['inspection', inspectionId] });
    } catch (error) {
      setPhotos((current) => ({ ...current, [item]: { src: photo.dataUrl, state: 'failed' } }));
      toast.show({ title: 'Photo not uploaded', description: humanError(error), tone: 'danger' });
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.put(`/inspections/${inspectionId}/findings`, {
        findings: findings.map((finding) => ({
          room,
          item: finding.item,
          condition: conditions[finding.item] ?? 'good',
          note: notes[finding.item] || undefined,
        })),
      });
      // The rooms screen reads the same query; without this it showed the old counts.
      await queryClient.invalidateQueries({ queryKey: ['inspection', inspectionId] });
      navigate(-1);
    } catch (error) {
      toast.show({ title: 'Not saved', description: humanError(error), tone: 'danger' });
    } finally {
      setSaving(false);
    }
  };

  if (!data) {
    return <QueryState isLoading={isLoading} isError={isError} error={error} onRetry={refetch} what="This inspection" />;
  }

  return (
    <main className="mx-auto max-w-lg px-4 py-6">
      <PageHeader
        title={room}
        description={
          locked
            ? 'Signing has started, so the findings are locked.'
            : 'Anything below Good needs a photo. It protects both sides.'
        }
      />
      <div className="space-y-3">
        {findings.map((finding) => {
          const item = finding.item;
          const condition = conditions[item] ?? 'good';
          return (
            <Card key={finding.id}>
              <CardBody className="space-y-3">
                <p className="text-body font-semibold">{item}</p>
                <SegmentedControl
                  value={condition}
                  onChange={(next) =>
                    !locked && setConditions((current) => ({ ...current, [item]: next as Condition }))
                  }
                  options={[
                    { label: 'Good', value: 'good' },
                    { label: 'Fair', value: 'fair' },
                    { label: 'Poor', value: 'poor' },
                    { label: 'Damaged', value: 'damaged' },
                    { label: 'Missing', value: 'missing' },
                  ]}
                />
                {condition !== 'good' ? (
                  <Textarea
                    rows={2}
                    placeholder="What exactly, and where"
                    value={notes[item] ?? ''}
                    disabled={locked}
                    onChange={(event) =>
                      setNotes((current) => ({ ...current, [item]: event.target.value }))
                    }
                  />
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  {finding.photoKeys.map((key) => (
                    <SignedImage
                      key={key}
                      storageKey={key}
                      alt={`${item} photo`}
                      className="h-16 w-16 rounded-sm object-cover"
                    />
                  ))}
                  {photos[item] ? (
                    <UploadTile
                      src={photos[item]!.src}
                      state={photos[item]!.state}
                      onRetry={() => capture(item)}
                    />
                  ) : null}
                  {!locked && condition !== 'good' ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={photos[item]?.state === 'uploading'}
                      onClick={() => capture(item)}
                    >
                      Add a photo
                    </Button>
                  ) : null}
                </div>
              </CardBody>
            </Card>
          );
        })}
      </div>
      {!locked ? (
        <Button block className="mt-5" loading={saving} onClick={save}>
          Save {room}
        </Button>
      ) : (
        <Button block variant="outline" className="mt-5" onClick={() => navigate(-1)}>
          Back
        </Button>
      )}
    </main>
  );
}
