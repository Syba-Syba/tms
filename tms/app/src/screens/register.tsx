import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, Link, useSearchParams } from 'react-router';
import { Button, Checkbox, Input, useToast } from '@hlonie/toolbox/ui';
import { Field } from '@hlonie/toolbox/forms';
import { api, humanError } from '../api/client';
import { startSession, type SessionUser } from '../lib/session';
import { PRIVACY_VERSION } from '../lib/privacy';
import { TERMS_VERSION } from '../lib/terms';
import { AuthHeading, AuthLayout } from '../components/auth-layout';
import { TEXT_LINK } from '../components/link-button';

type Kind = 'tenant' | 'landlord';

/** Tenants sign up to apply for a unit; landlords to open an account for their rentals. Agents
    never sign up here: they join through the owner's invitation. /register?as=landlord opens
    on the landlord form, for a link from a landlord's own website. */
export function Register() {
  const [params] = useSearchParams();
  const [kind, setKind] = useState<Kind>(params.get('as') === 'landlord' ? 'landlord' : 'tenant');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [business, setBusiness] = useState({ tradingName: '', phone: '' });
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const create = async () => {
    setBusy(true);
    try {
      const result = await api.post<{ token: string; user: SessionUser }>('/auth/register', {
        ...form,
        consentVersion: PRIVACY_VERSION,
        ...(kind === 'landlord' ? { landlord: business, termsVersion: TERMS_VERSION } : {}),
      });
      await startSession(result.token, result.user);
      // A new identity: nothing cached for whoever was signed in before may be shown to this one.
      queryClient.clear();
      // A landlord lands on the dashboard, where the setup checklist waits. An applicant goes
      // back to the listing they came from, if they followed a landlord's link.
      const listing = params.get('landlord');
      const unit = params.get('unit');
      const apply = listing
        ? `/apply?landlord=${encodeURIComponent(listing)}${unit ? `&unit=${encodeURIComponent(unit)}` : ''}`
        : '/apply';
      navigate(kind === 'landlord' ? '/' : apply, {
        replace: true,
      });
    } catch (error) {
      toast.show({ title: 'Account not created', description: humanError(error), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const missing = [
    form.name.trim().length < 2 ? 'your full name' : null,
    !form.email.includes('@') ? 'a valid email' : null,
    form.password.length < 8 ? 'a password of at least 8 characters' : null,
    kind === 'landlord' && business.tradingName.trim().length < 2 ? 'your business name' : null,
    kind === 'landlord' && !/^\+?[0-9 ]{9,16}$/.test(business.phone.trim()) ? 'a phone number' : null,
    !consent ? (kind === 'landlord' ? 'your agreement to the terms and privacy notice' : 'your agreement to the privacy notice') : null,
  ].filter(Boolean);
  const ready = missing.length === 0;

  return (
    <AuthLayout>
      <AuthHeading title="Create an account">
        {kind === 'landlord'
          ? 'Leases, rent, deposits and repairs for your rentals, kept the way the law asks.'
          : 'One account carries your application through to the lease, the deposit and beyond.'}
      </AuthHeading>
      <div className="space-y-4">
          {/* Two big choices rather than a small toggle: which one you are decides the whole form. */}
          <div role="tablist" aria-label="Who the account is for" className="grid grid-cols-2 gap-2">
            {([
              { value: 'tenant', label: 'I am renting', hint: 'Apply, sign and pay' },
              { value: 'landlord', label: 'I let property', hint: 'Run your rentals' },
            ] as const).map((option) => (
              <button
                key={option.value}
                type="button"
                role="tab"
                aria-selected={kind === option.value}
                onClick={() => setKind(option.value)}
                className={`rounded-md border px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tb-ring)] focus-visible:ring-offset-2 ${
                  kind === option.value ? 'border-brand-500 bg-brand-50' : 'border-line bg-surface hover:bg-surface-muted'
                }`}
              >
                <span className="block text-body font-bold text-ink">{option.label}</span>
                <span className="block text-meta text-ink-muted">{option.hint}</span>
              </button>
            ))}
          </div>
          {kind === 'landlord' ? (
            <>
              <Field label="Business name" htmlFor="reg-business" hint="Or your own name, if you have no company.">
              <Input
                id="reg-business"
                name="organization"
                autoComplete="organization"
                value={business.tradingName}
                onChange={(event) => setBusiness({ ...business, tradingName: event.target.value })}
              />
              </Field>
              <Field label="Phone" htmlFor="reg-phone" hint="For tenants to reach you.">
              <Input
                id="reg-phone"
                type="tel"
                name="tel"
                autoComplete="tel"
                value={business.phone}
                onChange={(event) => setBusiness({ ...business, phone: event.target.value })}
              />
              </Field>
            </>
          ) : null}
          <Field label={kind === 'landlord' ? 'Your full name' : 'Full name'} htmlFor="reg-name">
          <Input
            id="reg-name"
            name="name"
            autoComplete="name"
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
          </Field>
          <Field label="Email" htmlFor="reg-email">
          <Input
            id="reg-email"
            type="email"
            name="email"
            autoComplete="email"
            value={form.email}
            onChange={(event) => setForm({ ...form, email: event.target.value })}
          />
          </Field>
          <Field label="Password" htmlFor="reg-password" hint="At least 8 characters.">
          <Input
            id="reg-password"
            type="password"
            name="new-password"
            autoComplete="new-password"
            value={form.password}
            onChange={(event) => setForm({ ...form, password: event.target.value })}
          />
          </Field>
          <Checkbox
            id="register-consent"
            checked={consent}
            onChange={(event) => setConsent(event.target.checked)}
            label={
              kind === 'landlord' ? (
                <span>
                  I have read the{' '}
                  <Link to="/terms" target="_blank" className={TEXT_LINK}>terms of service</Link> and{' '}
                  <Link to="/privacy" target="_blank" className={TEXT_LINK}>privacy notice</Link>{' '}
                  and agree to them
                </span>
              ) : (
                <span>
                  I have read the{' '}
                  <Link to="/privacy" target="_blank" className={TEXT_LINK}>privacy notice</Link>{' '}
                  and agree to it
                </span>
              )
            }
          />
          <Button block size="lg" loading={busy} disabled={!ready} onClick={create}>
            Create the account
          </Button>
          {!ready ? (
            <p className="text-center text-meta text-ink-muted">Still needed: {missing.join(', ')}.</p>
          ) : null}
          <p className="text-center text-meta text-ink-muted">
            Already have one?{' '}
            <Link to="/login" className={TEXT_LINK}>Sign in</Link>
          </p>
      </div>
    </AuthLayout>
  );
}
