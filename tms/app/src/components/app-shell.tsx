import { NavLink, Outlet } from 'react-router-dom';
import { currentUser, endSession, isLandlord } from '../lib/session';

const LANDLORD = [
  { to: '/', label: 'Home', end: true },
  { to: '/properties', label: 'Properties' },
  { to: '/applications', label: 'Applications' },
  { to: '/tickets', label: 'Maintenance' },
  { to: '/settings/notifications', label: 'Notifications' },
];

const TENANT = [
  { to: '/', label: 'Home', end: true },
  { to: '/documents', label: 'Documents' },
  { to: '/tickets', label: 'Maintenance' },
  { to: '/settings/notifications', label: 'Notifications' },
];

/** The arch, once, as the mark. Everything else stays out of the way. */
function Mark() {
  return (
    <span className="flex items-center gap-2">
      <span className="h-5 w-4 rounded-t-full border-2 border-b-0 border-brand-500" />
      <b className="text-[15px] font-extrabold tracking-tight text-ink">Threshold</b>
    </span>
  );
}

export function AppShell() {
  const links = isLandlord() ? LANDLORD : TENANT;

  return (
    <div className="min-h-dvh bg-bg text-ink">
      <header className="border-b border-line-soft bg-surface">
        <div className="mx-auto flex max-w-5xl items-center gap-6 px-5 py-3">
          <Mark />
          <nav className="flex flex-1 gap-1 overflow-x-auto">
            {links.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                end={link.end}
                className={({ isActive }) =>
                  `whitespace-nowrap rounded-sm px-3 py-1.5 text-[13.5px] font-semibold ${
                    isActive ? 'bg-brand-50 text-brand-500' : 'text-ink-muted hover:text-ink'
                  }`
                }
              >
                {link.label}
              </NavLink>
            ))}
          </nav>
          <span className="hidden text-xs text-ink-muted sm:block">
            {currentUser()?.name}
          </span>
          <button
            type="button"
            onClick={() => endSession()}
            className="rounded-sm px-3 py-1.5 text-[13px] font-bold text-ink-muted hover:text-ink"
          >
            Log out
          </button>
        </div>
      </header>
      <Outlet />
    </div>
  );
}
