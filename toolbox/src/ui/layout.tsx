import { useState, type ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface NavItem {
  label: string;
  href: string;
  icon?: ReactNode;
  active?: boolean;
}

export function AppShell({
  brand,
  nav,
  headerRight,
  children,
}: {
  brand: ReactNode;
  nav: NavItem[];
  headerRight?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-h-dvh bg-bg text-ink">
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-surface px-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="rounded-sm p-2 hover:bg-surface-muted md:hidden"
            aria-label="Toggle navigation"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            =
          </button>
          <div className="font-display text-sm font-semibold">{brand}</div>
        </div>
        {headerRight}
      </header>
      <div className="flex">
        <aside
          className={cn(
            'w-60 shrink-0 border-r border-line bg-surface p-3 md:block',
            open ? 'block' : 'hidden',
          )}
        >
          <nav className="flex flex-col gap-1">
            {nav.map((item) => (
              <a
                key={item.href}
                href={item.href}
                aria-current={item.active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-md px-3 py-2 text-sm text-ink-muted hover:bg-surface-muted hover:text-ink',
                  item.active && 'bg-brand-50 text-brand-700',
                )}
              >
                {item.icon}
                {item.label}
              </a>
            ))}
          </nav>
        </aside>
        <main className="min-w-0 flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
