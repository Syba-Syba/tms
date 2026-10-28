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
        'min-h-24 w-full rounded-sm border border-line bg-surface px-3 py-2.5 text-[14px] text-ink outline-none placeholder:text-ink-muted focus:border-brand-500 focus:ring-1 focus:ring-brand-500',
        invalid && 'border-danger',
        className,
      )}
      {...props}
    />
  );
});
