import { cn } from '../lib/cn';

export type UploadState = 'queued' | 'uploading' | 'synced' | 'failed';

/** State lives in a corner tick, not a full overlay, so the photo stays visible while it syncs. */
export function UploadTile({
  src,
  state,
  progress = 0,
  onRetry,
  label,
  className,
}: {
  src?: string;
  state: UploadState;
  progress?: number;
  onRetry?: () => void;
  label?: string;
  className?: string;
}) {
  const tick = {
    queued: { text: '...', cls: 'bg-surface-muted text-ink-muted' },
    uploading: { text: `${Math.round(progress)}%`, cls: 'bg-info text-white' },
    synced: { text: 'ok', cls: 'bg-success text-white' },
    failed: { text: '!', cls: 'bg-danger text-white' },
  }[state];

  return (
    <figure
      className={cn(
        'relative aspect-square overflow-hidden rounded-md border border-line bg-surface-muted',
        className,
      )}
    >
      {src ? (
        <img src={src} alt={label ?? 'Captured photo'} className="h-full w-full object-cover" />
      ) : null}
      <figcaption
        className={cn(
          'absolute right-1 top-1 rounded-sm px-1.5 py-0.5 font-mono text-2xs font-medium',
          tick.cls,
        )}
      >
        {tick.text}
      </figcaption>
      {state === 'uploading' ? (
        <div className="absolute inset-x-0 bottom-0 h-1 bg-black/20">
          <div className="h-full bg-info transition-all" style={{ width: `${progress}%` }} />
        </div>
      ) : null}
      {state === 'failed' && onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="absolute inset-x-0 bottom-0 bg-danger py-1 text-2xs font-medium text-white"
        >
          Tap to retry
        </button>
      ) : null}
    </figure>
  );
}
