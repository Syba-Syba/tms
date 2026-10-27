import { cn } from '../lib/cn';

/** The delta is words, not an arrow icon. "4 running late" beats a red triangle. */
export function StatCard({
  label,
  value,
  delta,
  deltaTone = 'neutral',
  className,
}: {
  label: string;
  value: string;
  delta?: string;
  deltaTone?: 'good' | 'bad' | 'neutral';
  className?: string;
}) {
  return (
    <div className={cn('rounded-md border border-line bg-surface px-4 py-3.5', className)}>
      <p className="text-xs text-ink-muted">{label}</p>
      <p className="mt-1 font-display text-[26px] font-medium tabular-nums leading-tight text-ink">{value}</p>
      {delta ? (
        <p
          className={cn(
            'mt-0.5 text-[11px]',
            deltaTone === 'good' && 'text-success',
            deltaTone === 'bad' && 'text-danger',
            deltaTone === 'neutral' && 'text-ink-muted',
          )}
        >
          {delta}
        </p>
      ) : null}
    </div>
  );
}
