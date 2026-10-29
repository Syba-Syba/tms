import { useState, type ComponentType, type SVGProps } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { Drawer } from '@hlonie/toolbox/ui';
import { currentUser, endSession, isLandlord } from '../lib/session';
import { PlanBanner } from './plan-banner';
import { Wordmark } from './wordmark';
import {
  ActivityIcon, BuildingIcon, ChartIcon, FileIcon, HomeIcon, InboxIcon, LogOutIcon, MoreIcon, SettingsIcon, WalletIcon,
  WrenchIcon,
} from './nav-icons';

interface Item {
  to: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  end?: boolean;
}

/**
 * The first four go in the phone's bottom bar; the rest live behind More. On a laptop every
 * item sits in the top bar. The order is how often a landlord needs each one.
 */
const LANDLORD: Item[] = [
  { to: '/', label: 'Home', icon: HomeIcon, end: true },
  { to: '/payments', label: 'Payments', icon: WalletIcon },
  { to: '/tickets', label: 'Maintenance', icon: WrenchIcon },
  { to: '/properties', label: 'Properties', icon: BuildingIcon },
  { to: '/applications', label: 'Applications', icon: InboxIcon },
  { to: '/reports', label: 'Reports', icon: ChartIcon },
  { to: '/activity', label: 'Activity', icon: ActivityIcon },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
];

const TENANT: Item[] = [
  { to: '/', label: 'Home', icon: HomeIcon, end: true },
  { to: '/documents', label: 'Documents', icon: FileIcon },
  { to: '/tickets', label: 'Maintenance', icon: WrenchIcon },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
];

const BAR_SIZE = 4;

const isActive = (item: Item, pathname: string) =>
  item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`);

export function AppShell() {
  const items = isLandlord() ? LANDLORD : TENANT;
  // A tenant has four destinations, so all fit in the bar and More is not needed.
  const bar = items.length > BAR_SIZE + 1 ? items.slice(0, BAR_SIZE) : items;
  const overflow = items.length > BAR_SIZE + 1 ? items.slice(BAR_SIZE) : [];
  const { pathname } = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreActive = overflow.some((item) => isActive(item, pathname));

  return (
    <div className="min-h-dvh bg-bg text-ink">
      {/* WCAG 2.4.1: past the navigation in one keystroke. Hidden until it has focus. */}
      <a href="#content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-2 focus:z-50 focus:rounded-sm focus:bg-action focus:px-4 focus:py-2.5 focus:text-body focus:font-semibold focus:text-ink-inverse">
        Skip to content
      </a>
      <header className="sticky top-0 z-20 border-b border-line bg-surface">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-8 px-4 sm:px-5">
          <Wordmark />
          <nav className="hidden h-full flex-1 gap-6 md:flex" aria-label="Main">
            {items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive: active }) =>
                  `-mb-px flex items-center whitespace-nowrap border-b-2 text-body ${
                    active ? 'border-ink font-medium text-ink' : 'border-transparent text-ink-muted hover:text-ink'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <span className="ml-auto truncate text-meta text-ink-muted md:ml-0">{currentUser()?.name}</span>
          <button
            type="button"
            onClick={() => endSession()}
            className="hidden min-h-6 px-1 text-meta text-ink-muted underline-offset-4 hover:text-ink hover:underline md:block"
          >
            Log out
          </button>
        </div>
      </header>
      <PlanBanner />

      {/* Room for the bottom bar on phones, so the last card is never hidden behind it. */}
      <div id="content" tabIndex={-1} className="pb-[calc(4.5rem+env(safe-area-inset-bottom))] outline-none md:pb-0">
        <Outlet />
      </div>

      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        <div className="mx-auto flex max-w-lg">
          {bar.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className="flex-1">
              {({ isActive: active }) => <Tab icon={item.icon} label={item.label} active={active} />}
            </NavLink>
          ))}
          {overflow.length > 0 ? (
            <button type="button" className="flex-1" onClick={() => setMoreOpen(true)} aria-haspopup="dialog">
              <Tab icon={MoreIcon} label="More" active={moreActive} />
            </button>
          ) : (
            <button type="button" className="flex-1" onClick={() => endSession()}>
              <Tab icon={LogOutIcon} label="Log out" active={false} />
            </button>
          )}
        </div>
      </nav>

      <Drawer open={moreOpen} onOpenChange={setMoreOpen} title="More" side="bottom">
        <div className="-mx-2 space-y-1">
          {overflow.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              onClick={() => setMoreOpen(false)}
              className={({ isActive: active }) =>
                `flex items-center gap-3 rounded-sm px-3 py-3 text-lead ${
                  active ? 'bg-surface-muted font-medium text-ink' : 'text-ink hover:bg-surface-muted'
                }`
              }
            >
              <item.icon className="text-title" />
              {item.label}
            </NavLink>
          ))}
          <button
            type="button"
            onClick={() => endSession()}
            className="flex w-full items-center gap-3 rounded-sm px-3 py-3 text-lead text-ink-muted hover:bg-surface-muted"
          >
            <LogOutIcon className="text-[20px]" />
            Log out
          </button>
        </div>
      </Drawer>
    </div>
  );
}

function Tab({
  icon: Icon,
  label,
  active,
}: {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  label: string;
  active: boolean;
}) {
  return (
    <span
      className={`flex flex-col items-center gap-1 pb-2 pt-2.5 text-2xs ${
        active ? 'font-semibold text-ink' : 'text-ink-muted'
      }`}
    >
      <Icon className="text-[22px]" />
      {label}
    </span>
  );
}
