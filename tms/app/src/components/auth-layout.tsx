import type { ReactNode } from 'react';
import { Wordmark } from './wordmark';

const BENEFITS = [
  { title: 'Rent that is easy to follow', text: 'One reference for each lease, a statement both of you can see, and proof of payment sent from a phone.' },
  { title: 'Deposits kept the way the law asks', text: 'Held with interest, shown to the tenant, and settled with a statement when the lease ends.' },
  { title: 'Repairs that do not get lost', text: 'Reported with photos, assigned to a contractor, and closed only when the work is done.' },
];

/**
 * Every signed-out screen. On a laptop: the brand on a green panel to the left, speaking to
 * landlords and tenants alike, and the form on white to the right. On a phone: the wordmark,
 * then the form.
 */
export function AuthLayout({ children, wide = false, top }: { children: ReactNode; wide?: boolean; top?: ReactNode }) {
  return (
    <div className="min-h-dvh bg-surface lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <aside className="hidden flex-col justify-between bg-nav px-12 py-10 lg:sticky lg:top-0 lg:flex lg:h-dvh lg:self-start xl:px-16" aria-label="About Threshold">
        <Wordmark onDark />
        <div className="max-w-md">
          <p className="font-display text-hero font-bold leading-[1.1] tracking-[-0.02em] text-white">
            One place for the lease, the rent and the repairs.
          </p>
          <p className="mt-4 text-lead text-nav-text">
            Whether you let the place or live in it, you both see the same record.
          </p>
          <ul className="mt-10 space-y-5">
            {BENEFITS.map((benefit) => (
              <li key={benefit.title} className="border-t border-nav-active pt-4">
                <p className="text-lead font-bold text-white">{benefit.title}</p>
                <p className="mt-1 text-body text-nav-text">{benefit.text}</p>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-meta text-nav-muted">Made for renting in South Africa.</p>
      </aside>
      <main className="flex min-h-dvh flex-col justify-center px-4 py-10 sm:px-8">
        <div className={`mx-auto w-full ${wide ? 'max-w-xl' : 'max-w-sm'}`}>
          <div className={`mb-8 flex items-center justify-between gap-3 ${top ? '' : 'lg:hidden'}`}>
            <span className="lg:invisible">
              <Wordmark />
            </span>
            {top}
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}

/** The heading every signed-out form starts with. */
export function AuthHeading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <>
      <h1 className="mb-2 font-display text-display font-bold leading-tight tracking-[-0.01em] text-ink">{title}</h1>
      {children ? <p className="mb-6 text-body text-ink-muted">{children}</p> : null}
    </>
  );
}
