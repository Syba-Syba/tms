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
      <div>
        {breadcrumbs?.length ? (
          <nav aria-label="Breadcrumb" className="mb-1 flex gap-1 text-xs text-ink-muted">
            {breadcrumbs.map((crumb, index) => (
              <span key={crumb.label}>
                {index > 0 ? <span className="px-1">/</span> : null}
                {crumb.href ? (
                  <a href={crumb.href} className="hover:text-ink">
                    {crumb.label}
                  </a>
                ) : (
                  crumb.label
                )}
              </span>
            ))}
          </nav>
        ) : null}
        <h1 className="font-display text-display font-medium leading-tight tracking-[-0.01em] text-ink">{title}</h1>
        {description ? <p className="mt-1 text-body text-ink-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex gap-2">{actions}</div> : null}
    </header>
  );
}
