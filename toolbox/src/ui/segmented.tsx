import { cn } from '../lib/cn';

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: { label: string; value: T }[];
  value: T;
  onChange: (next: T) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      // Wraps onto a second row rather than running off a 360px screen.
      className={cn(
        'inline-flex max-w-full flex-wrap gap-0.5 rounded-[22px] bg-surface-muted p-1', className)}
    >
      {options.map((option) => (
        <button
          key={option.value}
          role="tab"
          type="button"
          aria-selected={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            'min-h-9 whitespace-nowrap rounded-full px-4 py-1.5 text-meta font-medium text-ink-muted transition-colors hover:text-ink',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tb-ring)]',
            option.value === value && 'bg-surface font-bold text-ink shadow-sm ring-1 ring-line',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
