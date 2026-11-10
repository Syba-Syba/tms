import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn';

// A badge is a label, never a paragraph: it keeps to one line and the row around it wraps instead.
const badge = cva('inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold', {
  variants: {
    tone: {
      neutral: 'bg-surface-muted text-ink',
      brand: 'bg-brand-100 text-brand-700',
      success: 'bg-tint-success text-[var(--tb-success-ink)]',
      warning: 'bg-tint-warning text-[var(--tb-warning-ink)]',
      danger: 'bg-tint-danger text-[var(--tb-danger-ink)]',
      info: 'bg-tint-info text-[var(--tb-info-ink)]',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export function Badge({
  className,
  tone,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badge>) {
  return <span className={cn(badge({ tone }), className)} {...props} />;
}
