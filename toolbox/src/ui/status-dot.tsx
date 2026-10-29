import { cn } from '../lib/cn';

const tones = {
  live: 'bg-success',
  idle: 'bg-warning',
  down: 'bg-danger',
  off: 'bg-neutral-400',
};

/** Only a live status pulses. A static problem should not draw the eye forever. */
export function StatusDot({
  tone,
  label,
  className,
}: {
  tone: keyof typeof tones;
  label: string;
  className?: string;
}) {
  return (
    <span className={cn('inline-flex items-center gap-2 text-body text-ink', className)}>
      <span className="relative flex h-2 w-2">
        {tone === 'live' ? (
          <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full opacity-60', tones[tone])} />
        ) : null}
        <span className={cn('relative inline-flex h-2 w-2 rounded-full', tones[tone])} />
      </span>
      {label}
    </span>
  );
}
