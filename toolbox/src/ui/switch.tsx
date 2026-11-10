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
        'inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tb-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--tb-surface)] disabled:opacity-50',
        checked ? 'border-brand-500 bg-brand-500' : 'border-neutral-300 bg-neutral-300',
        className,
      )}
    >
      <span
        className={cn(
          'h-5 w-5 rounded-full bg-white shadow-sm transition-transform',
          checked ? 'translate-x-6' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}
