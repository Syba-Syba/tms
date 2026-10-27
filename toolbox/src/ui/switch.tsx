import { cn } from '../lib/cn';

export function Switch({
  checked,
  onCheckedChange,
  label,
  disabled,
  className,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  label?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'inline-flex h-6 w-11 items-center rounded-full border border-line transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tb-ring)] disabled:opacity-50',
        checked ? 'bg-brand-500' : 'bg-surface-muted',
        className,
      )}
    >
      <span
        className={cn(
          'h-5 w-5 rounded-full bg-white ring-1 ring-black/10 transition-transform',
          checked ? 'translate-x-5' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}
