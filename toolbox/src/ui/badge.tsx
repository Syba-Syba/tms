import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn';

// A badge is a label, never a paragraph: it keeps to one line and the row around it wraps instead.
const badge = cva('inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[4px] px-1.5 py-0.5 text-xs font-medium', {
  variants: {
    tone: {
      neutral: 'bg-surface-muted text-ink',
      brand: 'bg-brand-100 text-brand-700',
      success: 'bg-[color-mix(in_srgb,var(--tb-success)_12%,transparent)] text-[var(--tb-success-ink)]',
      warning: 'bg-[color-mix(in_srgb,var(--tb-warning)_12%,transparent)] text-[var(--tb-warning-ink)]',
      danger: 'bg-[color-mix(in_srgb,var(--tb-danger)_12%,transparent)] text-[var(--tb-danger-ink)]',
      info: 'bg-[color-mix(in_srgb,var(--tb-info)_12%,transparent)] text-[var(--tb-info-ink)]',
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
