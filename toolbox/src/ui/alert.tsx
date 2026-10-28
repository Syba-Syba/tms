import { cn } from '../lib/cn';

/* A tinted panel with the title in the state colour. No side bar, no shadow. */
const tones = {
  info: 'bg-[color-mix(in_srgb,var(--tb-info)_7%,var(--tb-surface))] text-info',
  success: 'bg-[color-mix(in_srgb,var(--tb-success)_7%,var(--tb-surface))] text-success',
  warning: 'bg-[color-mix(in_srgb,var(--tb-warning)_8%,var(--tb-surface))] text-warning',
  danger: 'bg-[color-mix(in_srgb,var(--tb-danger)_7%,var(--tb-surface))] text-danger',
};

export function Alert({
  tone = 'info',
  title,
  children,
  className,
}: {
  tone?: keyof typeof tones;
  title: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn('rounded-md px-4 py-3', tones[tone], className)}
    >
      <p className="text-sm font-semibold">{title}</p>
      {children ? <div className="mt-0.5 text-sm text-ink">{children}</div> : null}
    </div>
  );
}
