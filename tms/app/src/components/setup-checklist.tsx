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
      title: 'Share your listings link',
      detail: 'Applicants apply through it. Approve one and the lease follows.',
      to: '/settings/account',
    },
  ];
  const left = steps.filter((step) => !step.done).length;

  return (
    <section aria-label="Set up your account" className="mb-6 rounded-md border border-line bg-surface p-4 sm:p-5">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="font-display text-[20px] font-medium">Set up {data.account.tradingName}</h2>
        <p className="text-[13px] text-ink-muted">{left} of {steps.length} to go</p>
      </div>
      <ol className="divide-y divide-line-soft">
        {steps.map((step, index) => (
          <li key={step.title}>
            <Link to={step.to} className="flex items-center gap-3 py-2.5">
              <span
                aria-hidden
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[12px] ${
                  step.done ? 'border-brand-500 bg-brand-500 text-white' : 'border-line text-ink-muted'
                }`}
              >
                {step.done ? <CheckIcon className="h-3.5 w-3.5" /> : index + 1}
              </span>
              <span className="min-w-0">
                <span className={`block text-[14px] font-semibold ${step.done ? 'text-ink-muted line-through' : 'text-ink'}`}>
                  {step.title}
                </span>
                {!step.done ? <span className="block text-xs text-ink-muted">{step.detail}</span> : null}
              </span>
              <span className="sr-only">{step.done ? 'Done' : 'To do'}</span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
