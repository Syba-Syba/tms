import { initials } from '../utils/format';
import { cn } from '../lib/cn';

const sizes = { sm: 'h-7 w-7 text-2xs', md: 'h-9 w-9 text-xs', lg: 'h-12 w-12 text-body' };

/** A soft tint with dark initials, derived from the name so a person keeps their colour. */
const tintFor = (name: string) => {
  const hues = [160, 205, 35, 265, 340, 95];
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  const hue = hues[hash % hues.length];
  return { background: `hsl(${hue} 55% 90%)`, color: `hsl(${hue} 60% 24%)` };
};

export type AvatarTone = 'success' | 'warning' | 'danger' | 'info';
const toneStyle = (tone: AvatarTone) => ({ background: `var(--tb-${tone}-tint)`, color: `var(--tb-${tone}-ink)` });

export function Avatar({
  name,
  src,
  size = 'md',
  tone,
  className,
}: {
  name: string;
  src?: string;
  size?: keyof typeof sizes;
  /** Colours the circle by state (paid up, owing) instead of by name. */
  tone?: AvatarTone;
  className?: string;
}) {
  return src ? (
    <img
      src={src}
      alt={name}
      className={cn('rounded-full object-cover', sizes[size], className)}
    />
  ) : (
    <span
      role="img"
      aria-label={name}
      style={tone ? toneStyle(tone) : tintFor(name)}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-bold',
        sizes[size],
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}

export function AvatarStack({ names, max = 4, size = 'sm' }: { names: string[]; max?: number; size?: keyof typeof sizes }) {
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  return (
    <span className="inline-flex items-center -space-x-2">
      {shown.map((name) => (
        <Avatar key={name} name={name} size={size} className="ring-2 ring-[var(--tb-surface)]" />
      ))}
      {rest > 0 ? (
        <span className={cn('inline-flex items-center justify-center rounded-full bg-surface-muted font-medium text-ink-muted ring-2 ring-[var(--tb-surface)]', sizes[size])}>
          +{rest}
        </span>
      ) : null}
    </span>
  );
}
