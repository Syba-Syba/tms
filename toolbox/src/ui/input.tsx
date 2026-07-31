import { forwardRef } from 'react';
import { cn } from '../lib/cn';

/* A quiet field on limestone. Focus draws a 2px accent baseline instead of a glowing ring. */
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
        'flex h-11 items-center gap-2 rounded-sm bg-surface-muted px-3.5 shadow-[var(--tb-edge)] transition-shadow',
        'focus-within:shadow-[var(--tb-edge),inset_0_-2px_0_var(--tb-brand-500)]',
        invalid && 'shadow-[var(--tb-edge),inset_0_-2px_0_var(--tb-danger)]',
        props.disabled && 'opacity-50',
        className,
      )}
    >
      {leading ? <span className="text-ink-muted">{leading}</span> : null}
      <input
        ref={ref}
        aria-invalid={invalid || undefined}
        className="w-full bg-transparent text-[15px] text-ink caret-brand-500 outline-none placeholder:text-ink-muted"
        {...props}
      />
      {trailing ? <span className="text-ink-muted">{trailing}</span> : null}
    </div>
  );
});
