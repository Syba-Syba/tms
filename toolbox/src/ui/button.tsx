import { forwardRef } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn';
import { Spinner } from './spinner';

/* Squared-off 12px corners on purpose: pills read iOS, sharp reads brutalist. This sits between.
   Depth is a 1px darker bottom edge, like pressed clay, and press sinks the button 1px. */
const button = cva(
  'inline-flex items-center justify-center gap-2 rounded-[12px] font-semibold tracking-[-0.01em] whitespace-nowrap transition-[transform,background-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--tb-ring)] active:translate-y-[1px] disabled:pointer-events-none disabled:opacity-40',
  {
    variants: {
      variant: {
        primary:
          'bg-brand-500 text-ink-inverse shadow-[inset_0_-1.5px_0_rgba(0,0,0,0.22)] hover:bg-brand-600 active:shadow-none',
        secondary: 'bg-brand-50 text-brand-500 hover:bg-brand-100',
        outline: 'bg-surface text-ink ring-1 ring-inset ring-[var(--tb-border)] hover:bg-surface-muted',
        ghost: 'text-brand-500 hover:bg-brand-50',
        danger:
          'bg-danger text-white shadow-[inset_0_-1.5px_0_rgba(0,0,0,0.22)] hover:brightness-105 active:shadow-none',
        link: 'text-brand-500 underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-9 px-3.5 text-[13px]',
        md: 'h-11 px-5 text-[15px]',
        lg: 'h-[52px] px-7 text-[16px]',
        icon: 'h-11 w-11',
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
