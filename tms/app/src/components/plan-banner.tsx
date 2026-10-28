import { Link, useLocation } from 'react-router';
import { daysUntil } from '../lib/format';
import { isLandlord } from '../lib/session';
import { standingText, useBilling } from '../lib/billing';

/**
 * A line across the top for a landlord whose plan needs them: lapsed, a failed payment, or a
 * trial or cancelled plan with a week or less to run. Quiet otherwise.
 */
export function PlanBanner() {
  const landlord = isLandlord();
  const { data } = useBilling(landlord);
  const { pathname } = useLocation();
  if (!landlord || !data || data.driver === 'off' || pathname === '/settings/billing') return null;
  const endsOn = data.standing === 'trial' ? data.trialEndsOn : data.paidUntil;
  const soon = endsOn ? daysUntil(endsOn) <= 7 : false;
  const show =
    data.standing === 'lapsed' || data.standing === 'past_due' || ((data.standing === 'trial' || data.standing === 'cancelling') && soon);
  if (!show) return null;
  const urgent = data.standing === 'lapsed' || data.standing === 'past_due';
  return (
    <div role="status" className={`border-b px-4 py-2 text-center text-[13px] ${urgent ? 'border-line bg-[color-mix(in_srgb,var(--tb-danger)_9%,var(--tb-surface))] text-ink' : 'border-line bg-surface-muted text-ink'}`}>
      {standingText(data)}{' '}
      <Link to="/settings/billing" className="font-bold text-brand-500 underline">
        {data.isOwner ? 'Choose a plan' : 'See the plan'}
      </Link>
    </div>
  );
}
