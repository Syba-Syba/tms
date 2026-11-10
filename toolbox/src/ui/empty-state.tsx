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
    // A soft panel, left aligned with the page: what will appear here, and the one button that fills it.
    <div className={cn('flex flex-col items-start gap-2 rounded-md border border-dashed border-neutral-300 bg-surface px-6 py-7 text-left', className)}>
      {icon ? <div className="text-ink-muted">{icon}</div> : null}
      <h2 className="text-lead font-bold text-ink">{title}</h2>
      {description ? <p className="max-w-prose text-body text-ink-muted">{description}</p> : null}
      {action ? <div className="mt-2 flex flex-wrap gap-2">{action}</div> : null}
    </div>
  );
}
