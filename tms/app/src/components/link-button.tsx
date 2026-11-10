import { Link, type LinkProps } from 'react-router';

const BASE =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm font-semibold transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tb-ring)] focus-visible:ring-offset-2';
const VARIANT = {
  primary: 'bg-action text-ink-inverse hover:bg-action-hover',
  secondary: 'bg-brand-50 text-brand-600 hover:bg-brand-100',
  outline: 'border border-neutral-300 bg-surface text-ink hover:border-ink-muted hover:bg-surface-muted',
} as const;
const SIZE = { sm: 'h-9 px-3.5 text-meta', md: 'h-11 px-4 text-body', lg: 'h-12 px-6 text-lead' } as const;

/** Navigation that should look like an action: a link drawn as the toolbox button. */
export function LinkButton({
  variant = 'outline',
  size = 'md',
  block = false,
  className = '',
  ...props
}: LinkProps & { variant?: keyof typeof VARIANT; size?: keyof typeof SIZE; block?: boolean }) {
  return <Link className={`${BASE} ${VARIANT[variant]} ${SIZE[size]} ${block ? 'w-full' : ''} ${className}`} {...props} />;
}

/** A plain text link, for navigation inside a sentence. */
export const TEXT_LINK =
  'font-semibold text-brand-600 underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tb-ring)]';
