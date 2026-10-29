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
    // Aligned with the page it sits in, inside a dashed outline: a place where something will go.
    <div className={cn('flex flex-col items-start gap-2 rounded-md border border-dashed border-line px-5 py-6 text-left', className)}>
      {icon ? <div className="text-ink-muted">{icon}</div> : null}
      <h2 className="text-lead font-semibold text-ink">{title}</h2>
      {description ? <p className="max-w-prose text-body text-ink-muted">{description}</p> : null}
      {action}
    </div>
  );
}
