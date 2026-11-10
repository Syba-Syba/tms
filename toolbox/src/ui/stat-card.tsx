import { cn } from '../lib/cn';

/**
 * A headline figure in a tile: a label, the number, one line of words under it.
 * The delta is words, not an arrow icon. "4 running late" beats a red triangle.
 * A `bad` delta turns the whole tile red, so the one number that needs attention stands out.
 */
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
  const bad = deltaTone === 'bad';
  return (
    <div
      className={cn(
        'rounded-md border px-5 py-4 shadow-sm',
        bad ? 'border-[color-mix(in_srgb,var(--tb-danger)_30%,transparent)] bg-tint-danger' : 'border-line bg-surface',
        className,
      )}
    >
      <p className="text-meta font-medium text-ink-muted">{label}</p>
      <p className={cn('mt-1.5 font-display text-figure font-bold', bad ? 'text-danger' : 'text-ink')}>
        {value}
      </p>
      {delta ? (
        <p
          className={cn(
            'mt-1 text-meta',
            deltaTone === 'good' && 'font-medium text-[var(--tb-success-ink)]',
            deltaTone === 'bad' && 'font-medium text-[var(--tb-danger-ink)]',
            deltaTone === 'neutral' && 'text-ink-muted',
          )}
        >
          {delta}
        </p>
      ) : null}
    </div>
  );
}
