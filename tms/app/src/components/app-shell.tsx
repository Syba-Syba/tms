import { useState, type ComponentType, type SVGProps } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { Drawer } from '@hlonie/toolbox/ui';
import { currentUser, endSession, isLandlord } from '../lib/session';
import {
  BuildingIcon, ChartIcon, FileIcon, HomeIcon, InboxIcon, LogOutIcon, MoreIcon, SettingsIcon, WalletIcon,
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
  { to: '/settings/notifications', label: 'Settings', icon: SettingsIcon },
];

const TENANT: Item[] = [
  { to: '/', label: 'Home', icon: HomeIcon, end: true },
  { to: '/documents', label: 'Documents', icon: FileIcon },
  { to: '/tickets', label: 'Maintenance', icon: WrenchIcon },
  { to: '/settings/notifications', label: 'Settings', icon: SettingsIcon },
];

const BAR_SIZE = 4;

/** The arch, once, as the mark. Everything else stays out of the way. */
function Mark() {
  return (
    <span className="flex items-center gap-2">
      <span className="h-5 w-4 rounded-t-full border-2 border-b-0 border-brand-500" />
      <b className="text-[15px] font-extrabold tracking-tight text-ink">Threshold</b>
    </span>
  );
}

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
      <header className="sticky top-0 z-20 border-b border-line-soft bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3 sm:px-5">
          <Mark />
          <nav className="hidden flex-1 gap-1 md:flex" aria-label="Main">
            {items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive: active }) =>
                  `whitespace-nowrap rounded-sm px-3 py-1.5 text-[13.5px] font-semibold ${
                    active ? 'bg-brand-50 text-brand-500' : 'text-ink-muted hover:text-ink'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <span className="ml-auto truncate text-xs text-ink-muted md:ml-0">{currentUser()?.name}</span>
          <button
            type="button"
            onClick={() => endSession()}
            className="hidden rounded-sm px-3 py-1.5 text-[13px] font-bold text-ink-muted hover:text-ink md:block"
          >
            Log out
          </button>
        </div>
      </header>

      {/* Room for the bottom bar on phones, so the last card is never hidden behind it. */}
      <div className="pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:pb-0">
        <Outlet />
      </div>

      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-20 border-t border-line-soft bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
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
                `flex items-center gap-3 rounded-md px-3 py-3 text-[15px] font-semibold ${
                  active ? 'bg-brand-50 text-brand-500' : 'text-ink hover:bg-surface-muted'
                }`
              }
            >
              <item.icon className="text-[20px]" />
              {item.label}
            </NavLink>
          ))}
          <button
            type="button"
            onClick={() => endSession()}
            className="flex w-full items-center gap-3 rounded-md px-3 py-3 text-[15px] font-semibold text-ink-muted hover:bg-surface-muted"
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
      className={`flex flex-col items-center gap-0.5 pb-2 pt-2.5 text-[11px] font-semibold ${
        active ? 'text-brand-500' : 'text-ink-muted'
      }`}
    >
      <Icon className="text-[22px]" />
      {label}
    </span>
  );
}
