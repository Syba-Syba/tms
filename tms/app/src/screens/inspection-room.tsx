import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router';
import { Camera, CameraResultType } from '@capacitor/camera';
import {
  Button, Card, CardBody, PageHeader, SegmentedControl, Spinner, Textarea, UploadTile, useToast,
  type UploadState,
} from '@hlonie/toolbox/ui';
import { api, humanError } from '../api/client';
import { SignedImage } from '../components/signed-image';
import type { InspectionState } from './inspection-rooms';

type Condition = 'good' | 'fair' | 'poor' | 'damaged' | 'missing';

export function InspectionRoom() {
  const { inspectionId, room = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [conditions, setConditions] = useState<Record<string, Condition>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [photos, setPhotos] = useState<Record<string, { src: string; state: UploadState }>>({});
  const [saving, setSaving] = useState(false);

  const { data, isLoading } = useQuery({
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
    // 1600px keeps an embedded report photo small enough to email.
    const photo = await Camera.getPhoto({
      quality: 70,
      width: 1600,
      resultType: CameraResultType.DataUrl,
    });
    if (!photo.dataUrl) return;
    setPhotos((current) => ({ ...current, [item]: { src: photo.dataUrl!, state: 'uploading' } }));
    const blob = await (await fetch(photo.dataUrl)).blob();
    try {
      const { uploadUrl, photoId } = await api.post<{ uploadUrl: string; photoId: string }>(
        `/inspections/${inspectionId}/photos/presign`,
        { room, item, contentType: 'image/jpeg', sizeBytes: blob.size },
      );
      await fetch(uploadUrl, { method: 'PUT', body: blob, headers: { 'content-type': 'image/jpeg' } });
      // The server only puts confirmed photos in the sealed report.
      await api.post('/photos/confirm', { scope: 'inspection', photoId });
      setPhotos((current) => ({ ...current, [item]: { src: photo.dataUrl!, state: 'synced' } }));
    } catch {
      setPhotos((current) => ({ ...current, [item]: { src: photo.dataUrl!, state: 'failed' } }));
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
      navigate(-1);
    } catch (error) {
      toast.show({ title: 'Not saved', description: humanError(error), tone: 'danger' });
    } finally {
      setSaving(false);
    }
  };

  if (isLoading || !data) return <main className="p-16 text-center"><Spinner /></main>;

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
                <p className="text-[14.5px] font-semibold">{item}</p>
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
                    <Button size="sm" variant="outline" onClick={() => capture(item)}>
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
