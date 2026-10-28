import { NavLink } from 'react-router';
import { isLandlord } from '../lib/session';

const LINKS = [
  { to: '/settings/account', label: 'Account' },
  { to: '/settings/team', label: 'Team' },
  { to: '/settings/billing', label: 'Plan' },
  { to: '/settings/notifications', label: 'You' },
];

/** Landlords have three settings pages; tenants only their own, so they get no tabs. */
export function SettingsNav() {
  if (!isLandlord()) return null;
  return (
    <nav aria-label="Settings" className="mb-6 flex gap-5 border-b border-line">
      {LINKS.map((link) => (
        <NavLink
          key={link.to}
          to={link.to}
          className={({ isActive }) =>
            `-mb-px border-b-2 pb-2 text-[14px] ${
              isActive ? 'border-ink font-semibold text-ink' : 'border-transparent text-ink-muted hover:text-ink'
            }`
          }
        >
          {link.label}
        </NavLink>
      ))}
    </nav>
  );
}
