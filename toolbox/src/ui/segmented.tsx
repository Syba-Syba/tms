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
      className={cn('inline-flex rounded-sm border border-line bg-surface-muted p-0.5', className)}
    >
      {options.map((option) => (
        <button
          key={option.value}
          role="tab"
          type="button"
          aria-selected={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded-[4px] px-3.5 py-1.5 text-meta text-ink-muted transition-colors',
            option.value === value && 'bg-surface font-medium text-ink ring-1 ring-line',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
