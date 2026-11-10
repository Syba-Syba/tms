import type { ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';

/**
 * Shared pieces for the landlord's core screens (Overview, a lease, a deposit settlement):
 * figure tiles, a card with a headed list, a list of key facts, and a link drawn as a button.
 */

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm font-semibold transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tb-ring)] focus-visible:ring-offset-2';
const BUTTON_VARIANT = {
  primary: 'bg-action text-ink-inverse hover:bg-action-hover',
  secondary: 'bg-brand-50 text-brand-600 hover:bg-brand-100',
  outline: 'border border-neutral-300 bg-surface text-ink hover:border-ink-muted hover:bg-surface-muted',
} as const;
const BUTTON_SIZE = { sm: 'h-9 px-3.5 text-meta', md: 'h-11 px-4 text-body' } as const;

/** Navigation that is the next step, so it looks like the button beside it. */
export function ActionLink({
  variant = 'outline',
  size = 'md',
  block = false,
  className = '',
  ...props
}: LinkProps & { variant?: keyof typeof BUTTON_VARIANT; size?: keyof typeof BUTTON_SIZE; block?: boolean }) {
  return (
    <Link
      className={`${BUTTON_BASE} ${BUTTON_VARIANT[variant]} ${BUTTON_SIZE[size]} ${block ? 'w-full' : ''} ${className}`}
      {...props}
    />
  );
}

/** A text link for navigation only, such as "See all". */
export const NAV_LINK =
  'inline-flex min-h-6 items-center rounded-sm text-meta font-semibold text-brand-600 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tb-ring)]';

/**
 * One headline figure. `tone="danger"` is for the one bad number on the screen. With `to` the
 * whole tile is a link to where that number is worked on.
 */
export function StatTile({ label, value, note, tone = 'plain', to, children }: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: 'plain' | 'danger';
  to?: string;
  children?: ReactNode;
}) {
  const box = `block h-full rounded-md border px-5 py-4 shadow-sm ${
    tone === 'danger' ? 'border-danger/30 bg-tint-danger' : 'border-line bg-surface'
  }`;
  const body = (
    <>
      <p className="text-meta font-semibold text-ink-muted">{label}</p>
      <p className={`mt-1 text-figure font-bold leading-tight ${tone === 'danger' ? 'text-danger' : 'text-ink'}`}>
        {value}
      </p>
      {note ? <p className="mt-1 text-meta text-ink-muted">{note}</p> : null}
      {children}
    </>
  );
  return to ? (
    <Link
      to={to}
      className={`${box} transition-colors hover:border-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tb-ring)] focus-visible:ring-offset-2`}
    >
      {body}
    </Link>
  ) : (
    <div className={box}>{body}</div>
  );
}

/** A thin bar for "this much of that", read out as a percentage. */
export function ShareBar({ value, max, label }: { value: number; max: number; label: string }) {
  const percent = max > 0 ? Math.min(100, Math.max(0, Math.round((value / max) * 100))) : 0;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      className="mt-3 h-2 overflow-hidden rounded-full bg-neutral-200"
    >
      <div className="h-full rounded-full bg-brand-500" style={{ width: `${percent}%` }} />
    </div>
  );
}

/** A card with a bold heading, an optional action on the right, and its content below a rule. */
export function SectionCard({ title, count, action, children, className = '', label }: {
  title: string;
  /** A small figure beside the heading, such as how many rows follow. */
  count?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Names the region for screen readers when it differs from the heading. */
  label?: string;
}) {
  return (
    <section aria-label={label ?? title} className={`rounded-md border border-line bg-surface shadow-sm ${className}`}>
      <div className="flex min-h-14 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line-soft px-5 py-3">
        <h2 className="text-lead font-bold text-ink">
          {title}
          {count !== undefined ? <span className="ml-2 text-meta font-semibold text-ink-muted">{count}</span> : null}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Rows of a list inside a card: `<ul className={ROWS}>` with `<li className={ROW}>`. */
export const ROWS = 'divide-y divide-line-soft';
export const ROW = 'flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 py-3.5';

/** Label and value pairs down the side column: rent, deposit, dates. */
export function FactList({ facts }: { facts: { label: string; value: ReactNode }[] }) {
  return (
    <dl className={ROWS}>
      {facts.map((fact) => (
        <div key={fact.label} className="flex items-baseline justify-between gap-4 px-5 py-3">
          <dt className="text-meta text-ink-muted">{fact.label}</dt>
          <dd className="min-w-0 break-words text-right text-body font-semibold text-ink">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The tinted square that marks a task or a row by its state, with a short mark inside. */
export function StateMark({ tone, children }: { tone: 'danger' | 'warning' | 'info' | 'success'; children: ReactNode }) {
  const tint = {
    danger: 'bg-tint-danger text-[var(--tb-danger-ink)]',
    warning: 'bg-tint-warning text-[var(--tb-warning-ink)]',
    info: 'bg-tint-info text-[var(--tb-info-ink)]',
    success: 'bg-tint-success text-[var(--tb-success-ink)]',
  }[tone];
  return (
    <span aria-hidden className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-sm text-meta font-bold ${tint}`}>
      {children}
    </span>
  );
}
