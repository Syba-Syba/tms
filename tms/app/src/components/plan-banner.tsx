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
    <div role="status" className={`flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b px-4 py-2.5 text-center text-meta font-medium text-ink ${urgent ? 'border-[color-mix(in_srgb,var(--tb-danger)_30%,transparent)] bg-tint-danger' : 'border-[color-mix(in_srgb,var(--tb-warning)_30%,transparent)] bg-tint-warning'}`}>
      <span>{standingText(data)}</span>
      <Link to="/settings/billing" className="font-bold underline underline-offset-2 hover:no-underline">
        {data.isOwner ? 'Choose a plan' : 'See the plan'}
      </Link>
    </div>
  );
}
