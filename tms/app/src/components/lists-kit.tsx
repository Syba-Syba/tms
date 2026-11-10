import type { ReactNode } from 'react';
import { Link } from 'react-router';

/**
 * Shared pieces for the list screens (properties, applications, payments, listings, lease
 * signing, tenant import): headline tiles, a segmented control with counts, an upload area and
 * a link that looks like the button it sits beside.
 */

/** A headline figure. `tone="danger"` is for the one bad number on a screen. */
export function ListsTile({ label, value, note, tone = 'plain' }: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: 'plain' | 'danger';
}) {
  return (
    <div
      className={`rounded-md border px-5 py-4 shadow-sm ${
        tone === 'danger' ? 'border-danger/30 bg-tint-danger' : 'border-line bg-surface'
      }`}
    >
      <p className="text-meta font-semibold text-ink-muted">{label}</p>
      <p className={`mt-1 text-figure font-bold ${tone === 'danger' ? 'text-danger' : 'text-ink'}`}>{value}</p>
      {note ? <p className="mt-1 text-meta text-ink-muted">{note}</p> : null}
    </div>
  );
}

/** Tiles in a row on laptops, two across on phones. */
export function ListsTiles({ children, columns = 4 }: { children: ReactNode; columns?: 3 | 4 }) {
  return (
    <div className={`mb-6 grid grid-cols-2 gap-3 sm:gap-4 ${columns === 4 ? 'lg:grid-cols-4' : 'lg:grid-cols-3'}`}>
      {children}
    </div>
  );
}

/**
 * Tabs as one pill-shaped control, each with an optional count. Selects on mouse down as well
 * as on click, the way the tabs it replaces did, so a press that slides off still lands.
 */
export function ListsTabs<T extends string>({ options, value, onChange, label, className = '' }: {
  options: { value: T; label: string; count?: number; tone?: 'danger' | 'info' }[];
  value: T;
  onChange: (next: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div role="tablist" aria-label={label}
      className={`inline-flex max-w-full flex-wrap gap-1 rounded-md border border-line bg-surface p-1 shadow-sm ${className}`}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            role="tab"
            type="button"
            aria-selected={selected}
            onMouseDown={() => onChange(option.value)}
            onClick={() => onChange(option.value)}
            className={`inline-flex h-10 items-center gap-2 whitespace-nowrap rounded-sm px-4 text-body font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tb-ring)] ${
              selected ? 'bg-brand-50 text-brand-700' : 'text-ink-muted hover:bg-surface-muted hover:text-ink'
            }`}
          >
            {option.label}
            {option.count !== undefined ? (
              <span
                className={`inline-flex min-w-6 justify-center rounded-full px-1.5 py-0.5 text-xs font-bold ${
                  option.count > 0 && option.tone === 'danger'
                    ? 'bg-danger text-white'
                    : option.count > 0 && option.tone === 'info'
                      ? 'bg-tint-info text-[var(--tb-info-ink)]'
                      : 'bg-surface-muted text-ink-muted'
                }`}
              >
                {option.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

const LINK_BUTTON = {
  outline: 'border border-neutral-300 bg-surface text-ink hover:border-ink-muted hover:bg-surface-muted',
  primary: 'bg-action text-ink-inverse hover:bg-action-hover',
  secondary: 'bg-brand-50 text-brand-600 hover:bg-brand-100',
} as const;
const LINK_SIZE = { sm: 'h-9 px-3.5 text-meta', md: 'h-11 px-4 text-body' } as const;

/** The classes of a toolbox Button, for a link that must look like one. */
export const listsButtonClass = (variant: keyof typeof LINK_BUTTON = 'outline', size: keyof typeof LINK_SIZE = 'sm') =>
  `inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--tb-ring)] ${LINK_BUTTON[variant]} ${LINK_SIZE[size]}`;

/** Navigation that sits in a row of buttons. */
export function ListsLinkButton({ to, children, variant = 'outline', size = 'sm', className = '', ...rest }: {
  to: string;
  children: ReactNode;
  variant?: keyof typeof LINK_BUTTON;
  size?: keyof typeof LINK_SIZE;
  className?: string;
  'aria-label'?: string;
}) {
  return <Link to={to} className={`${listsButtonClass(variant, size)} ${className}`} {...rest}>{children}</Link>;
}

/** A doorway, the app's mark, drawn in the current colour. */
export function ListsDoorway({ className = 'h-8 w-6' }: { className?: string }) {
  return <span aria-hidden className={`block rounded-t-full border-2 border-b-0 border-current ${className}`} />;
}

/**
 * A file picker that reads as a place to put a file: a dashed area with the instruction, the
 * formats, and the real input stretched over it, so a click, a key press or a drop all work.
 */
export function ListsUploadArea({ label, title, hint, accept, disabled, busy, onFile }: {
  /** The accessible name of the file input. */
  label: string;
  title: string;
  hint: string;
  accept: string;
  disabled?: boolean;
  busy?: boolean;
  onFile: (file: File) => void;
}) {
  return (
    <label
      className={`relative flex flex-col items-center gap-2 rounded-md border-2 border-dashed border-brand-200 bg-brand-50 px-5 py-8 text-center transition-colors focus-within:border-brand-500 hover:border-brand-500 ${
        disabled ? 'opacity-60' : 'cursor-pointer'
      }`}
    >
      <span className="text-brand-500"><ListsDoorway /></span>
      <span className="text-lead font-bold text-ink">{busy ? 'Reading the file…' : title}</span>
      <span className="max-w-prose text-meta text-ink-muted">{hint}</span>
      <span className={`${listsButtonClass('primary', 'md')} mt-1`} aria-hidden>Choose a file</span>
      <input
        type="file"
        accept={accept}
        disabled={disabled}
        aria-label={label}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onFile(file);
          event.target.value = '';
        }}
      />
    </label>
  );
}

/** A numbered line in a "what happens next" side card. */
export function ListsSteps({ steps }: { steps: { title: string; detail?: string }[] }) {
  return (
    <ol className="space-y-4">
      {steps.map((step, index) => (
        <li key={step.title} className="grid grid-cols-[28px_1fr] gap-x-3">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-50 text-meta font-bold text-brand-700" aria-hidden>
            {index + 1}
          </span>
          <span>
            <span className="block text-body font-semibold text-ink">{step.title}</span>
            {step.detail ? <span className="block text-meta text-ink-muted">{step.detail}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
