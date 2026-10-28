import { useState } from 'react';
import { useNavigate, Link, useSearchParams } from 'react-router';
import { Button, Card, CardBody, Checkbox, Input, SegmentedControl, useToast } from '@hlonie/toolbox/ui';
import { api, humanError } from '../api/client';
import { startSession, type SessionUser } from '../lib/session';
import { PRIVACY_VERSION } from '../lib/privacy';
import { TERMS_VERSION } from '../lib/terms';

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

  const create = async () => {
    setBusy(true);
    try {
      const result = await api.post<{ token: string; user: SessionUser }>('/auth/register', {
        ...form,
        consentVersion: PRIVACY_VERSION,
        ...(kind === 'landlord' ? { landlord: business, termsVersion: TERMS_VERSION } : {}),
      });
      await startSession(result.token, result.user);
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
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4 py-10">
      <h1 className="mb-1 font-display text-[30px] font-medium leading-tight tracking-[-0.01em]">Create an account</h1>
      <p className="mb-5 text-[14px] text-ink-muted">
        {kind === 'landlord'
          ? 'Leases, rent, deposits and repairs for your rentals, kept the way the law asks.'
          : 'One account carries your application through to the lease, the deposit and beyond.'}
      </p>
      <Card>
        <CardBody className="space-y-3">
          <SegmentedControl
            options={[
              { value: 'tenant', label: 'I am renting' },
              { value: 'landlord', label: 'I let property' },
            ]}
            value={kind}
            onChange={setKind}
          />
          {kind === 'landlord' ? (
            <>
              <Input
                placeholder="Business name, or your own name"
                aria-label="Business name"
                name="organization"
                autoComplete="organization"
                value={business.tradingName}
                onChange={(event) => setBusiness({ ...business, tradingName: event.target.value })}
              />
              <Input
                type="tel"
                placeholder="Phone, for tenants to reach you"
                aria-label="Phone"
                name="tel"
                autoComplete="tel"
                value={business.phone}
                onChange={(event) => setBusiness({ ...business, phone: event.target.value })}
              />
            </>
          ) : null}
          <Input
            placeholder={kind === 'landlord' ? 'Your full name' : 'Full name'}
            name="name"
            autoComplete="name"
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
          <Input
            type="email"
            placeholder="Email"
            name="email"
            autoComplete="email"
            value={form.email}
            onChange={(event) => setForm({ ...form, email: event.target.value })}
          />
          <Input
            type="password"
            placeholder="Password, at least 8 characters"
            name="new-password"
            autoComplete="new-password"
            value={form.password}
            onChange={(event) => setForm({ ...form, password: event.target.value })}
          />
          <Checkbox
            id="register-consent"
            checked={consent}
            onChange={(event) => setConsent(event.target.checked)}
            label={
              kind === 'landlord' ? (
                <span>
                  I have read the{' '}
                  <Link to="/terms" target="_blank" className="font-bold text-brand-500">terms of service</Link> and{' '}
                  <Link to="/privacy" target="_blank" className="font-bold text-brand-500">privacy notice</Link>{' '}
                  and agree to them
                </span>
              ) : (
                <span>
                  I have read the{' '}
                  <Link to="/privacy" target="_blank" className="font-bold text-brand-500">privacy notice</Link>{' '}
                  and agree to it
                </span>
              )
            }
          />
          <Button block loading={busy} disabled={!ready} onClick={create}>
            Create the account
          </Button>
          {!ready ? (
            <p className="text-center text-xs text-ink-muted">Still needed: {missing.join(', ')}.</p>
          ) : null}
          <p className="text-center text-[13px] text-ink-muted">
            Already have one?{' '}
            <Link to="/login" className="font-bold text-brand-500">Sign in</Link>
          </p>
        </CardBody>
      </Card>
    </main>
  );
}
