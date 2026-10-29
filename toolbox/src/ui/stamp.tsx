import { cn } from '../lib/cn';

const tones = {
  approved: 'text-success border-success',
  declined: 'text-danger border-danger',
  paid: 'text-brand-600 border-brand-600',
  pending: 'text-warning border-warning',
  neutral: 'text-ink-muted border-ink-muted',
};

/** A rubber stamp: doubled border, uppercase, one degree off square. Ink never lands straight. */
export function Stamp({
  tone = 'neutral',
  children,
  tilt = -1.5,
  className,
}: {
  tone?: keyof typeof tones;
  children: React.ReactNode;
  tilt?: number;
  className?: string;
}) {
  return (
    <span
      style={{ transform: `rotate(${tilt}deg)` }}
      className={cn(
        'inline-block select-none border-2 px-2 py-0.5 font-display text-2xs uppercase tracking-[0.12em]',
        'shadow-[inset_0_0_0_1.5px_var(--tb-surface)] outline outline-1 outline-offset-[-4px] outline-current/0',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
