import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { Card, PageHeader } from '@hlonie/toolbox/ui';
import { isLandlord } from '../lib/session';
import { PAGE } from '../lib/layout';

const LINKS = [
  { to: '/settings/account', label: 'Account', hint: 'Business, bank and listings link' },
  { to: '/settings/team', label: 'Team', hint: 'Who works on your rentals' },
  { to: '/settings/billing', label: 'Plan', hint: 'What you pay for Threshold' },
  { to: '/settings/notifications', label: 'You', hint: 'Password, emails and your data' },
];

/**
 * Landlords have four settings pages; tenants only their own, so they get no navigation.
 * On a laptop it is a list down the left of the page; on a phone, a row of pills above it.
 */
export function SettingsNav() {
  if (!isLandlord()) return null;
  return (
    <nav aria-label="Settings" className="mb-5 lg:mb-0">
      <ul className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0 lg:sticky lg:top-6 lg:flex-col lg:gap-1 lg:overflow-visible lg:rounded-md lg:border lg:border-line lg:bg-surface lg:p-2 lg:shadow-sm">
        {LINKS.map((link) => (
          <li key={link.to} className="shrink-0">
            <NavLink
              to={link.to}
              className={({ isActive }) =>
                `block rounded-full px-4 py-2 text-body transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tb-ring)] lg:rounded-sm lg:px-3 lg:py-2.5 ${
                  isActive
                    ? 'bg-brand-100 font-bold text-brand-700'
                    : 'bg-surface font-medium text-ink-muted hover:bg-surface-muted hover:text-ink max-lg:border max-lg:border-line lg:bg-transparent'
                }`
              }
            >
              {link.label}
              <span className="hidden text-xs font-normal text-ink-muted lg:block">{link.hint}</span>
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * The frame every settings page shares: the title, the sub-navigation down the left on a
 * laptop, and the page's cards on the right.
 */
export function SettingsLayout({ description, children }: { description: string; children: ReactNode }) {
  const landlord = isLandlord();
  return (
    <main className={PAGE.wide}>
      <PageHeader title="Settings" description={description} />
      <div className={landlord ? 'lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:items-start lg:gap-8' : ''}>
        <SettingsNav />
        <div className="min-w-0 space-y-5">{children}</div>
      </div>
    </main>
  );
}

/** One topic on a settings page: a card with its heading inside, and an optional action beside it. */
export function SettingsCard({
  title,
  label,
  description,
  action,
  children,
  className = '',
}: {
  title: string;
  /** The section's accessible name, when it differs from the visible heading. */
  label?: string;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section aria-label={label ?? title} className={className}>
      <Card className="h-full">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-5 pt-5">
          <div className="min-w-0">
            <h2 className="text-lead font-bold text-ink">{title}</h2>
            {description ? <p className="mt-0.5 text-meta text-ink-muted">{description}</p> : null}
          </div>
          {action}
        </div>
        <div className="space-y-4 px-5 pb-5 pt-4">{children}</div>
      </Card>
    </section>
  );
}
