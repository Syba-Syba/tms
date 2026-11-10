import { forwardRef } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn';
import { Spinner } from './spinner';

/* The primary action is the brand green, so a screen has one obvious next step. Outline
   buttons are white with a 1px rule; `secondary` is a green tint for the action beside it. */
const button = cva(
  'inline-flex items-center justify-center gap-2 rounded-sm font-semibold whitespace-nowrap transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--tb-ring)] disabled:pointer-events-none disabled:opacity-40',
  {
    variants: {
      variant: {
        primary: 'bg-action text-ink-inverse hover:bg-action-hover',
        secondary: 'bg-brand-50 text-brand-600 hover:bg-brand-100',
        outline: 'border border-neutral-300 bg-surface text-ink hover:border-ink-muted hover:bg-surface-muted',
        ghost: 'text-ink-muted hover:bg-surface-muted hover:text-ink',
        danger: 'bg-danger text-white hover:brightness-95',
        link: 'text-brand-500 font-semibold underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-9 px-3.5 text-meta',
        md: 'h-11 px-4 text-body',
        lg: 'h-12 px-6 text-lead',
        icon: 'h-10 w-10',
      },
      block: { true: 'w-full' },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {
  loading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, block, loading, leftIcon, rightIcon, children, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(button({ variant, size, block }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <Spinner size="sm" /> : leftIcon}
      {children}
      {!loading && rightIcon}
    </button>
  );
});
