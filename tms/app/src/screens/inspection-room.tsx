import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router';
import {
  Alert, Badge, Button, Card, PageHeader, Textarea, UploadTile, useToast,
  type UploadState,
} from '@hlonie/toolbox/ui';
import { api, humanError } from '../api/client';
import { QueryState } from '../components/query-state';
import { SignedImage } from '../components/signed-image';
import { pickPhoto, putFile } from '../lib/photos';
import type { InspectionState } from './inspection-rooms';
import { ChoiceGroup, type Choice } from '../components/choice-group';
import { PAGE } from '../lib/layout';

type Condition = 'good' | 'fair' | 'poor' | 'damaged' | 'missing';

const FLAGGED = new Set<string>(['poor', 'damaged', 'missing']);
const CONDITIONS: Choice<Condition>[] = [
  { label: 'Good', value: 'good', tone: 'success' },
  { label: 'Fair', value: 'fair' },
  { label: 'Poor', value: 'poor', tone: 'warning' },
  { label: 'Damaged', value: 'damaged', tone: 'danger' },
  { label: 'Missing', value: 'missing', tone: 'danger' },
];

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
    } catch (error) {
      setPhotos((current) => ({ ...current, [item]: { src: photo.dataUrl, state: 'failed' } }));
      toast.show({ title: 'Photo not uploaded', description: humanError(error), tone: 'danger' });
      return;
    }
    // Once the reloaded inspection lists the photo, it is shown from there; keeping the local
    // tile as well showed every new photo twice.
    try {
      await queryClient.invalidateQueries({ queryKey: ['inspection', inspectionId] });
    } finally {
      setPhotos((current) => {
        if (current[item]?.src !== photo.dataUrl) return current;
        const { [item]: _synced, ...rest } = current;
        return rest;
      });
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

  const missed = data.status === 'missed';
  const flagged = findings.filter((finding) => FLAGGED.has(conditions[finding.item] ?? finding.condition)).length;

  return (
    <main className={PAGE.wide}>
      <PageHeader
        title={room}
        description={
          missed
            ? 'This inspection was cancelled, so nothing can be recorded here.'
            : locked
              ? 'Signing has started, so the findings are locked. To dispute one, reopen the inspection from its overview.'
              : 'Anything below Good needs a photo. It protects both sides.'
        }
      />
      {missed ? (
        <Alert tone="warning" title="This inspection did not happen" className="mb-5">
          It was cancelled because the notice was withdrawn or the inspection was booked again for another day.
          What is below is only what was on file when that happened.
        </Alert>
      ) : null}
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <Card>
          <ul className="divide-y divide-line-soft">
            {findings.map((finding) => {
              const item = finding.item;
              const condition = conditions[item] ?? 'good';
              return (
                <li key={finding.id} className="space-y-3 px-5 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                    <p className="text-lead font-semibold text-ink">{item}</p>
                    <ChoiceGroup
                      label={`Condition of ${item}`}
                      value={condition}
                      disabled={locked}
                      onChange={(next) => setConditions((current) => ({ ...current, [item]: next }))}
                      options={CONDITIONS}
                    />
                  </div>
                  {condition !== 'good' ? (
                    <Textarea
                      rows={2}
                      aria-label={`Note on ${item}`}
                      placeholder="What exactly, and where"
                      value={notes[item] ?? ''}
                      disabled={locked}
                      onChange={(event) =>
                        setNotes((current) => ({ ...current, [item]: event.target.value }))
                      }
                    />
                  ) : null}
                  {finding.photoKeys.length > 0 || photos[item] || (!locked && condition !== 'good') ? (
                    <div className="flex flex-wrap items-center gap-2">
                      {finding.photoKeys.map((key) => (
                        <SignedImage
                          key={key}
                          storageKey={key}
                          alt={`${item} photo`}
                          className="h-20 w-20 rounded-sm border border-line object-cover"
                        />
                      ))}
                      {photos[item] ? (
                        <UploadTile
                          className="w-20"
                          src={photos[item]!.src}
                          state={photos[item]!.state}
                          onRetry={() => capture(item)}
                        />
                      ) : null}
                      {!locked && condition !== 'good' ? (
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={`Add a photo of ${item}`}
                          disabled={photos[item]?.state === 'uploading'}
                          onClick={() => capture(item)}
                        >
                          Add a photo
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Card>

        <aside className="space-y-4 lg:sticky lg:top-6">
          <Card>
            <div className="space-y-3 px-5 py-4">
              <h2 className="text-lead font-bold text-ink">This room</h2>
              <dl className="space-y-1.5 text-body">
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-muted">Items</dt>
                  <dd className="font-bold text-ink">{findings.length}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-ink-muted">Need attention</dt>
                  <dd>{flagged ? <Badge tone="warning">{flagged} flagged</Badge> : <span className="font-bold text-ink">None</span>}</dd>
                </div>
              </dl>
              {!locked ? (
                <Button block size="lg" loading={saving} onClick={save}>
                  Save {room}
                </Button>
              ) : (
                <Button block variant="outline" onClick={() => navigate(-1)}>
                  Back
                </Button>
              )}
            </div>
          </Card>
          {!locked ? (
            <p className="px-1 text-meta text-ink-muted">
              Poor, damaged and missing items are flagged on the report. Saving takes you back to the list of rooms.
            </p>
          ) : null}
        </aside>
      </div>
    </main>
  );
}
