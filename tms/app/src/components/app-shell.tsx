import { useState, type ComponentType, type SVGProps } from 'react';
import { useQuery } from '@tanstack/react-query';
import { NavLink, Outlet, useLocation } from 'react-router';
import { Avatar, Drawer } from '@hlonie/toolbox/ui';
import { api } from '../api/client';
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
  /** Starts the second group in the sidebar: the things looked up, not worked through. */
  records?: boolean;
}

/**
 * The first four go in the phone's bottom bar; the rest live behind More. On a laptop every
 * item sits in the sidebar. The order is how often a landlord needs each one.
 */
const LANDLORD: Item[] = [
  { to: '/', label: 'Home', icon: HomeIcon, end: true },
  { to: '/payments', label: 'Payments', icon: WalletIcon },
  { to: '/tickets', label: 'Repairs', icon: WrenchIcon },
  { to: '/properties', label: 'Properties', icon: BuildingIcon },
  { to: '/applications', label: 'Applications', icon: InboxIcon },
  { to: '/reports', label: 'Reports', icon: ChartIcon, records: true },
  { to: '/documents', label: 'Documents', icon: FileIcon },
  { to: '/activity', label: 'Activity', icon: ActivityIcon },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
];

const TENANT: Item[] = [
  { to: '/', label: 'Home', icon: HomeIcon, end: true },
  { to: '/documents', label: 'Documents', icon: FileIcon },
  { to: '/tickets', label: 'Repairs', icon: WrenchIcon },
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
  const name = currentUser()?.name ?? '';
  const counts = useNavCounts(isLandlord());

  return (
    <div className="min-h-dvh bg-bg text-ink lg:pl-60">
      {/* WCAG 2.4.1: past the navigation in one keystroke. Hidden until it has focus. */}
      <a href="#content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-2 focus:z-50 focus:rounded-sm focus:bg-action focus:px-4 focus:py-2.5 focus:text-body focus:font-semibold focus:text-ink-inverse">
        Skip to content
      </a>
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-60 flex-col bg-nav px-3.5 py-5 text-nav-text lg:flex">
        <div className="px-2.5 pb-6"><Wordmark onDark /></div>
        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto" aria-label="Main">
          {items.map((item) => (
            <div key={item.to} className="contents">
              {item.records ? <p className="px-2.5 pb-1.5 pt-5 text-2xs font-semibold uppercase tracking-[0.08em] text-nav-muted">Records</p> : null}
              <NavLink
                to={item.to}
                end={item.end}
                className={({ isActive: active }) =>
                  `flex min-h-10 items-center gap-3 rounded-sm px-2.5 text-body font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nav-accent ${
                    active ? 'bg-nav-active text-white' : 'text-nav-text hover:bg-nav-active/60 hover:text-white'
                  }`
                }
              >
                <item.icon className="text-[18px]" />
                {item.label}
                <Count n={counts[item.to]} urgent={item.to !== '/applications'} />
              </NavLink>
            </div>
          ))}
        </nav>
        <div className="mt-3 flex items-center gap-2.5 border-t border-nav-active px-1.5 pt-4">
          <Avatar name={name} size="md" className="!bg-nav-accent !text-nav" />
          <span className="min-w-0 flex-1 truncate text-meta font-medium text-white">{name}</span>
          <button type="button" onClick={() => endSession()} aria-label="Log out" title="Log out"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm text-nav-muted hover:bg-nav-active hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nav-accent">
            <LogOutIcon className="text-[18px]" />
          </button>
        </div>
      </aside>
      <header className="sticky top-0 z-20 border-b border-line bg-surface lg:hidden">
        <div className="flex h-14 items-center gap-3 px-4">
          <Wordmark />
          <span className="ml-auto truncate text-meta text-ink-muted">{name}</span>
          <Avatar name={name} size="sm" />
        </div>
      </header>
      <PlanBanner />

      {/* Room for the bottom bar on phones, so the last card is never hidden behind it. */}
      <div id="content" tabIndex={-1} className="pb-[calc(4.5rem+env(safe-area-inset-bottom))] outline-none lg:pb-0">
        <Outlet />
      </div>

      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden"
      >
        <div className="mx-auto flex max-w-lg">
          {bar.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className="flex-1">
              {({ isActive: active }) => <Tab icon={item.icon} label={item.label} active={active} count={counts[item.to]} />}
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
                  active ? 'bg-brand-50 font-semibold text-brand-600' : 'text-ink hover:bg-surface-muted'
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
  count,
}: {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  label: string;
  active: boolean;
  count?: number;
}) {
  return (
    <span
      className={`flex flex-col items-center gap-1 pb-2 pt-2.5 text-2xs ${
        active ? 'font-bold text-brand-500' : 'font-medium text-ink-muted'
      }`}
    >
      <span className="relative">
        <Icon className="text-[22px]" />
        {count ? <span className="absolute -right-2 -top-1 min-w-4 rounded-full bg-danger px-1 text-center text-[10px] font-bold leading-4 text-white">{count}</span> : null}
      </span>
      {label}
    </span>
  );
}

/** A count beside a sidebar item: red when something is waiting on the landlord and late. */
function Count({ n, urgent }: { n?: number; urgent: boolean }) {
  if (!n) return null;
  return (
    <span className={`ml-auto min-w-5 rounded-full px-1.5 text-center text-xs font-bold leading-5 ${urgent ? 'bg-danger text-white' : 'bg-nav-active text-white'}`}>
      {n}
    </span>
  );
}

/**
 * What is waiting, by destination: slips to check, open repairs, applications to decide. The
 * same query keys as the screens, so opening one costs no second request.
 */
function useNavCounts(enabled: boolean): Record<string, number> {
  const slips = useQuery({
    queryKey: ['payment-proofs'], enabled,
    queryFn: () => api.get<{ items: { id: string }[] }>('/payment-proofs'),
  });
  const tickets = useQuery({
    queryKey: ['tickets'], enabled,
    queryFn: () => api.get<{ items: { status: string }[] }>('/tickets'),
  });
  const applications = useQuery({
    queryKey: ['applications'], enabled,
    queryFn: () => api.get<{ items: { status: string }[] }>('/applications'),
  });
  return {
    '/payments': slips.data?.items.length ?? 0,
    '/tickets': tickets.data?.items.filter((t) => !['closed', 'cancelled'].includes(t.status)).length ?? 0,
    '/applications': applications.data?.items.filter((a) => ['submitted', 'screening'].includes(a.status)).length ?? 0,
  };
}
