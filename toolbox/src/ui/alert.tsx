import { cn } from '../lib/cn';

/* A tinted panel with a bold title in the state's ink. No side bar, no shadow. */
const tones = {
  info: 'border-[color-mix(in_srgb,var(--tb-info)_25%,transparent)] bg-tint-info text-[var(--tb-info-ink)]',
  success: 'border-[color-mix(in_srgb,var(--tb-success)_25%,transparent)] bg-tint-success text-[var(--tb-success-ink)]',
  warning: 'border-[color-mix(in_srgb,var(--tb-warning)_30%,transparent)] bg-tint-warning text-[var(--tb-warning-ink)]',
  danger: 'border-[color-mix(in_srgb,var(--tb-danger)_30%,transparent)] bg-tint-danger text-[var(--tb-danger-ink)]',
};

export function Alert({
  tone = 'info',
  title,
  children,
  className,
  live,
}: {
  tone?: keyof typeof tones;
  title: string;
  children?: React.ReactNode;
  className?: string;
  /**
   * How a screen reader hears it. Most alerts are text that is simply part of the page, so the
   * default is a polite status for warnings and errors and nothing for the rest. Pass
   * `assertive` only for something that interrupts, such as a failed save.
   */
  live?: 'off' | 'polite' | 'assertive';
}) {
  const mode = live ?? (tone === 'danger' || tone === 'warning' ? 'polite' : 'off');
  const role = mode === 'assertive' ? 'alert' : mode === 'polite' ? 'status' : undefined;
  return (
    <div role={role} className={cn('rounded-md border px-4 py-3.5', tones[tone], className)}>
      <p className="text-body font-bold">{title}</p>
      {children ? <div className="mt-1 text-body text-ink">{children}</div> : null}
    </div>
  );
}
