import type { ReactNode } from 'react';

export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  breadcrumbs?: { label: string; href?: string }[];
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {breadcrumbs?.length ? (
          <nav aria-label="Breadcrumb" className="mb-1.5 flex flex-wrap gap-1 text-meta text-ink-muted">
            {breadcrumbs.map((crumb, index) => (
              <span key={crumb.label}>
                {index > 0 ? <span className="px-1">/</span> : null}
                {crumb.href ? (
                  <a href={crumb.href} className="font-medium hover:text-ink hover:underline">
                    {crumb.label}
                  </a>
                ) : (
                  crumb.label
                )}
              </span>
            ))}
          </nav>
        ) : null}
        <h1 className="font-display text-display font-bold leading-tight tracking-[-0.01em] text-ink">{title}</h1>
        {description ? <p className="mt-1 text-lead text-ink-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}
