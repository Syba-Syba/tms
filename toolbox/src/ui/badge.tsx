import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn';

// A badge is a label, never a paragraph: it keeps to one line and the row around it wraps instead.
const badge = cva('inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium', {
  variants: {
    tone: {
      neutral: 'bg-surface-muted text-ink',
      brand: 'bg-brand-100 text-brand-700',
      success: 'bg-[color-mix(in_srgb,var(--tb-success)_15%,transparent)] text-success',
      warning: 'bg-[color-mix(in_srgb,var(--tb-warning)_15%,transparent)] text-warning',
      danger: 'bg-[color-mix(in_srgb,var(--tb-danger)_15%,transparent)] text-danger',
      info: 'bg-[color-mix(in_srgb,var(--tb-info)_15%,transparent)] text-info',
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
