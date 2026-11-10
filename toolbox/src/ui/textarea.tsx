import { forwardRef } from 'react';
import { cn } from '../lib/cn';

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }
>(function Textarea({ className, invalid, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        'min-h-24 w-full rounded-sm border border-neutral-300 bg-surface px-3.5 py-2.5 text-body text-ink outline-none transition-colors placeholder:text-ink-muted',
        'focus:border-brand-500 focus:ring-2 focus:ring-[var(--tb-ring)] focus:ring-offset-1 focus:ring-offset-[var(--tb-surface)] disabled:bg-surface-muted disabled:opacity-60',
        invalid && 'border-danger focus:border-danger focus:ring-danger',
        className,
      )}
      {...props}
    />
  );
});
