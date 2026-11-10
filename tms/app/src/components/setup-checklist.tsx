import { Link } from 'react-router';
import { CheckIcon } from '@hlonie/toolbox/icons';
import { useLandlord } from '../lib/landlord';

/**
 * A new landlord's first four steps, on the dashboard until the account can take rent: the
 * bank account, a property, a unit, and an applicant through the listings link. It goes away
 * on its own once there is a tenant on a lease.
 */
export function SetupChecklist() {
  const { data } = useLandlord();
  if (!data || (data.onboarding.done && data.onboarding.tenant)) return null;
  const owner = data.me.role === 'owner';
  const steps = [
    {
      done: data.onboarding.bank,
      title: 'Add the bank account rent goes into',
      detail: owner ? 'It prints on invoices and the tenant’s rent screen.' : 'The account owner adds this.',
      to: '/settings/account',
    },
    { done: data.onboarding.property, title: 'Add a property', detail: 'The building or house, with its address.', to: '/properties' },
    { done: data.onboarding.unit, title: 'Add a unit with its rent', detail: 'Each flat or room you let on its own lease.', to: '/properties' },
    {
      done: data.onboarding.tenant,
      title: 'Add your tenants',
      detail: 'Bring in the ones renting now, or share your listings link for new applicants.',
      to: '/tenants/import',
    },
  ];
  const left = steps.filter((step) => !step.done).length;

  return (
    <section aria-label="Set up your account" className="mb-6 rounded-md border border-line bg-surface shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line-soft px-5 py-4">
        <h2 className="text-lead font-bold text-ink">Set up {data.account.tradingName}</h2>
        <p className="text-meta text-ink-muted">{left} of {steps.length} to go</p>
      </div>
      <ol className="divide-y divide-line-soft">
        {steps.map((step, index) => (
          <li key={step.title}>
            <Link
              to={step.to}
              className="flex items-center gap-3.5 px-5 py-3.5 hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--tb-ring)]"
            >
              <span
                aria-hidden
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-sm text-meta font-bold ${
                  step.done ? 'bg-tint-success text-[var(--tb-success-ink)]' : 'bg-surface-muted text-ink-muted'
                }`}
              >
                {step.done ? <CheckIcon className="h-4 w-4" /> : index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block text-body font-bold ${step.done ? 'text-ink-muted' : 'text-ink'}`}>
                  {step.title}
                </span>
                {!step.done ? <span className="block text-meta text-ink-muted">{step.detail}</span> : null}
              </span>
              {step.done ? (
                <span className="shrink-0 rounded-full bg-tint-success px-2.5 py-0.5 text-xs font-semibold text-[var(--tb-success-ink)]">Done</span>
              ) : (
                <>
                  <span className="sr-only">To do</span>
                  <span aria-hidden className="inline-flex h-9 shrink-0 items-center rounded-sm bg-brand-50 px-3.5 text-meta font-semibold text-brand-600">
                    Start
                  </span>
                </>
              )}
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
