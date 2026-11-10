import { cn } from '../lib/cn';

export function ProgressBar({
  value,
  max = 100,
  label,
  className,
}: {
  value: number;
  max?: number;
  label?: string;
  className?: string;
}) {
  const percent = Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div className={className}>
      {label ? (
        <div className="mb-1.5 flex justify-between text-meta text-ink-muted">
          <span>{label}</span>
          <span className="font-semibold text-ink">{Math.round(percent)}%</span>
        </div>
      ) : null}
      <div
        role="progressbar"
        aria-valuenow={value}
        aria-valuemax={max}
        className="h-2 overflow-hidden rounded-full bg-neutral-200"
      >
        <div
          className={cn('h-full rounded-full bg-brand-500 transition-all')}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
