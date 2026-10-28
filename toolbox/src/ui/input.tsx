import { forwardRef } from 'react';
import { cn } from '../lib/cn';

/* A white field with a 1px rule, as on a paper form. Focus darkens the rule to the accent. */
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
        'flex h-10 items-center gap-2 rounded-sm border border-line bg-surface px-3 transition-colors',
        'focus-within:border-brand-500 focus-within:ring-1 focus-within:ring-brand-500',
        invalid && 'border-danger focus-within:border-danger focus-within:ring-danger',
        props.disabled && 'opacity-50',
        className,
      )}
    >
      {leading ? <span className="text-ink-muted">{leading}</span> : null}
      <input
        ref={ref}
        aria-invalid={invalid || undefined}
        className="w-full bg-transparent text-[14px] text-ink caret-brand-500 outline-none placeholder:text-ink-muted"
        {...props}
      />
      {trailing ? <span className="text-ink-muted">{trailing}</span> : null}
    </div>
  );
});
