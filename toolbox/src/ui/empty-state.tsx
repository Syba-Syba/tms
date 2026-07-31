import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center gap-3 px-6 py-14 text-center', className)}>
      {icon ? <div className="text-ink-muted">{icon}</div> : null}
      <h3 className="font-display text-lg font-semibold text-ink">{title}</h3>
      {description ? <p className="max-w-sm text-sm text-ink-muted">{description}</p> : null}
      {action}
    </div>
  );
}
