import { forwardRef } from 'react';
import { cn } from '../lib/cn';

export const Checkbox = forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement> & { label?: React.ReactNode }
>(function Checkbox({ className, label, id, ...props }, ref) {
  return (
    <label className="inline-flex items-center gap-2.5 text-body text-ink" htmlFor={id}>
      <input
        ref={ref}
        id={id}
        type="checkbox"
        className={cn(
          'h-5 w-5 shrink-0 rounded-[5px] border border-neutral-300 accent-[var(--tb-brand-500)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tb-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--tb-surface)]',
          className,
        )}
        {...props}
      />
      {label}
    </label>
  );
});
