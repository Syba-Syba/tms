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
        'min-h-24 w-full rounded-sm border-0 bg-surface-muted px-3.5 py-2.5 text-sm text-ink outline-none placeholder:text-ink-muted focus:ring-2 focus:ring-[var(--tb-ring)]',
        invalid && 'border-danger',
        className,
      )}
      {...props}
    />
  );
});
