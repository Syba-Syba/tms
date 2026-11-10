import { forwardRef } from 'react';
import { cn } from '../lib/cn';

/* A white field, 44px tall. Focus turns the rule green and adds a soft green ring. */
export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'prefix'> {
  invalid?: boolean;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid, leading, trailing, ...props },
  ref,
) {
  return (
    <div
      className={cn(
        'flex h-11 items-center gap-2 rounded-sm border border-neutral-300 bg-surface px-3.5 transition-colors',
        'focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-[var(--tb-ring)] focus-within:ring-offset-1 focus-within:ring-offset-[var(--tb-surface)]',
        invalid && 'border-danger focus-within:border-danger focus-within:ring-danger',
        props.disabled && 'bg-surface-muted opacity-60',
        className,
      )}
    >
      {leading ? <span className="text-ink-muted">{leading}</span> : null}
      <input
        ref={ref}
        aria-invalid={invalid || undefined}
        className="w-full bg-transparent text-body text-ink caret-brand-500 outline-none placeholder:text-ink-muted"
        {...props}
      />
      {trailing ? <span className="text-ink-muted">{trailing}</span> : null}
    </div>
  );
});
