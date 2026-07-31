import { forwardRef } from 'react';
import { cn } from '../lib/cn';

export const Checkbox = forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement> & { label?: React.ReactNode }
>(function Checkbox({ className, label, id, ...props }, ref) {
  return (
    <label className="inline-flex items-center gap-2 text-sm text-ink" htmlFor={id}>
      <input
        ref={ref}
        id={id}
        type="checkbox"
        className={cn(
          'h-4 w-4 rounded-sm border border-line accent-[var(--tb-brand-500)] focus-visible:ring-2 focus-visible:ring-[var(--tb-ring)]',
          className,
        )}
        {...props}
      />
      {label}
    </label>
  );
});
