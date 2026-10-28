import { useState, type ComponentType, type SVGProps } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { Drawer } from '@hlonie/toolbox/ui';
import { currentUser, endSession, isLandlord } from '../lib/session';
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
  { to: '/settings/notifications', label: 'Settings', icon: SettingsIcon },
];

const TENANT: Item[] = [
  { to: '/', label: 'Home', icon: HomeIcon, end: true },
  { to: '/documents', label: 'Documents', icon: FileIcon },
  { to: '/tickets', label: 'Maintenance', icon: WrenchIcon },
  { to: '/settings/notifications', label: 'Settings', icon: SettingsIcon },
];

const BAR_SIZE = 4;

/** A doorway, drawn once, and the name set in the statement serif. */
function Mark() {
  return (
    <span className="flex items-center gap-2">
      <span className="h-[18px] w-[14px] rounded-t-full border-[1.5px] border-b-0 border-ink" aria-hidden />
      <b className="font-display text-[19px] font-semibold tracking-[-0.01em] text-ink">Threshold</b>
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
      <header className="sticky top-0 z-20 border-b border-line bg-surface">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-8 px-4 sm:px-5">
          <Mark />
          <nav className="hidden h-full flex-1 gap-6 md:flex" aria-label="Main">
            {items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive: active }) =>
                  `-mb-px flex items-center whitespace-nowrap border-b-2 text-[14px] ${
                    active ? 'border-ink font-medium text-ink' : 'border-transparent text-ink-muted hover:text-ink'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <span className="ml-auto truncate text-[13px] text-ink-muted md:ml-0">{currentUser()?.name}</span>
          <button
            type="button"
            onClick={() => endSession()}
            className="hidden text-[13px] text-ink-muted underline-offset-4 hover:text-ink hover:underline md:block"
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
                `flex items-center gap-3 rounded-sm px-3 py-3 text-[15px] ${
                  active ? 'bg-surface-muted font-medium text-ink' : 'text-ink hover:bg-surface-muted'
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
            className="flex w-full items-center gap-3 rounded-sm px-3 py-3 text-[15px] text-ink-muted hover:bg-surface-muted"
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
      className={`flex flex-col items-center gap-1 pb-2 pt-2.5 text-[11px] ${
        active ? 'font-semibold text-ink' : 'text-ink-muted'
      }`}
    >
      <Icon className="text-[22px]" />
      {label}
    </span>
  );
}
