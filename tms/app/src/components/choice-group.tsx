import { useRef } from 'react';

type Tone = 'neutral' | 'success' | 'warning' | 'danger';

export interface Choice<T extends string> {
  value: T;
  label: string;
  /** A second line, shown on the big `cards` layout. */
  hint?: string;
  /** The colour the choice takes once it is chosen. */
  tone?: Tone;
}

const CHOSEN: Record<Tone, string> = {
  neutral: 'border-brand-500 bg-brand-50 text-brand-700',
  success: 'border-success/40 bg-tint-success text-[var(--tb-success-ink)]',
  warning: 'border-warning/40 bg-tint-warning text-[var(--tb-warning-ink)]',
  danger: 'border-danger/40 bg-tint-danger text-[var(--tb-danger-ink)]',
};

/**
 * One choice out of a few, as tappable pills or big cards. A real radio group: one stop in the
 * tab order, the arrow keys move the choice, and a screen reader says which is chosen.
 */
export function ChoiceGroup<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
  layout = 'pills',
  className = '',
}: {
  label: string;
  options: Choice<T>[];
  value: T;
  onChange: (next: T) => void;
  disabled?: boolean;
  layout?: 'pills' | 'cards';
  className?: string;
}) {
  const group = useRef<HTMLDivElement>(null);
  const move = (event: React.KeyboardEvent) => {
    if (disabled) return;
    const index = Math.max(0, options.findIndex((option) => option.value === value));
    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (index + 1) % options.length
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (index - 1 + options.length) % options.length
      : event.key === 'Home' ? 0
      : event.key === 'End' ? options.length - 1
      : null;
    if (next === null) return;
    event.preventDefault();
    onChange(options[next]!.value);
    group.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };
  const anyChosen = options.some((option) => option.value === value);
  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      onKeyDown={move}
      className={`${layout === 'cards' ? 'grid grid-cols-1 gap-2 sm:grid-cols-3' : 'flex flex-wrap gap-1.5'} ${className}`}
    >
      {options.map((option, index) => {
        const chosen = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={chosen}
            disabled={disabled}
            tabIndex={chosen || (!anyChosen && index === 0) ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={`border text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tb-ring)] focus-visible:ring-offset-2 disabled:cursor-default ${
              layout === 'cards' ? 'rounded-md px-4 py-3' : 'min-h-9 rounded-full px-3.5 py-1.5 text-meta font-semibold'
            } ${
              chosen
                ? CHOSEN[option.tone ?? 'neutral']
                : `border-line bg-surface text-ink ${disabled ? 'opacity-50' : 'hover:bg-surface-muted'}`
            }`}
          >
            {layout === 'cards' ? (
              <>
                <span className="block text-body font-bold">{option.label}</span>
                {option.hint ? <span className={`block text-meta ${chosen ? '' : 'text-ink-muted'}`}>{option.hint}</span> : null}
              </>
            ) : (
              option.label
            )}
          </button>
        );
      })}
    </div>
  );
}
