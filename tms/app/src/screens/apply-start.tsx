import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Alert, Button, Checkbox, Select, useToast } from '@hlonie/toolbox/ui';
import { SelectField, TextField } from '@hlonie/toolbox/forms';
import { api, humanError } from '../api/client';
import { Money } from '../components/money';
import { PRIVACY_VERSION } from '../lib/privacy';
import { incomeCents } from '../lib/income';
import { currentUser } from '../lib/session';
import { AuthHeading, AuthLayout } from '../components/auth-layout';
import { LinkButton, TEXT_LINK } from '../components/link-button';

interface AvailableUnit {
  id: string;
  label: string;
  suburb: string;
  city: string;
  bedrooms: number;
  bathrooms: number;
  monthlyRentCents: number;
  depositCents: number;
}

interface FormValues {
  firstName: string;
  lastName: string;
  idNumber: string;
  email: string;
  phone: string;
  employmentStatus: 'employed' | 'self_employed' | 'contract' | 'unemployed' | 'retired';
  employer: string;
  monthlyIncome: string;
  occupants: string;
  preferredMoveIn: string;
}

export function ApplyStart() {
  // The account was made a minute ago with a name and an email; asking for them again lost
  // people who missed the empty email field at the top of a long form on a phone.
  const { control, handleSubmit, formState } = useForm<FormValues>({
    defaultValues: (() => {
      const user = currentUser();
      const [firstName = '', ...rest] = (user?.name ?? '').trim().split(/\s+/);
      return { email: user?.email ?? '', firstName, lastName: rest.join(' ') };
    })(),
  });
  const navigate = useNavigate();
  const toast = useToast();
  const [consent, setConsent] = useState(false);
  const [creditConsent, setCreditConsent] = useState(false);
  // From the router, not window.location: the two agree in a browser, and only the router
  // knows the address under a test or an in-app navigation that has not painted yet.
  const [params] = useSearchParams();
  const [unitId, setUnitId] = useState(() => params.get('unit') ?? '');

  // Arrives from the landlord's listings page, /l/their-name, as /apply?landlord=their-name.
  // It is what scopes the list.
  const landlord = params.get('landlord') ?? '';
  const { data: available, isError: unknownLandlord } = useQuery({
    queryKey: ['available-units', landlord],
    queryFn: () =>
      api.get<{ items: AvailableUnit[]; landlord: { name: string } | null; needsLink: boolean }>(
        landlord ? `/units/available?landlord=${encodeURIComponent(landlord)}` : '/units/available',
      ),
    retry: false,
  });
  const units = available?.items ?? [];
  const chosen = useMemo(() => units.find((unit) => unit.id === unitId), [units, unitId]);

  // A copied link can name a unit that has since been held or let. The picker showed "Choose a
  // unit" for it while the form still posted the id nobody could see, so it is cleared and said.
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!available || !unitId) return;
    if (!available.items.some((unit) => unit.id === unitId)) {
      setUnitId('');
      setGone(true);
    }
  }, [available, unitId]);

  const submit = handleSubmit(async (values) => {
    if (!unitId) {
      toast.show({ title: 'Pick a unit first', tone: 'warning' });
      return;
    }
    try {
      const created = await api.post<{ id: string }>('/applications', {
        unitId,
        ...values,
        // The field refuses anything this cannot read, so it is a number by now.
        monthlyIncomeCents: incomeCents(values.monthlyIncome),
        occupants: Number(values.occupants),
        pets: false,
        consentVersion: PRIVACY_VERSION,
        creditCheckConsent: creditConsent,
      });
      navigate(`/apply/${created.id}/documents`);
    } catch (error) {
      toast.show({ title: 'Application not sent', description: humanError(error), tone: 'danger' });
    }
  });

  return (
    <AuthLayout wide top={<LinkButton to="/" size="sm">Your home</LinkButton>}>
      <AuthHeading title={available?.landlord ? `Apply to ${available.landlord.name}` : 'Apply for a unit'}>
        Applying holds the unit for you while the landlord decides.
      </AuthHeading>
      {available?.needsLink || unknownLandlord ? (
        <Alert tone="info" title={unknownLandlord ? 'That listings link does not work' : 'Use your landlord’s link'} className="mb-4">
          Each landlord shares their own link to apply. Ask them for it, or open it again from their listing.
        </Alert>
      ) : null}
      {available?.needsLink || unknownLandlord ? null : (
        <div className="space-y-6">
          <section className="space-y-3" aria-labelledby="apply-unit">
            <h2 id="apply-unit" className="text-lead font-bold text-ink">The place</h2>
            {gone ? (
              <Alert tone="warning" title="That unit is no longer available">
                {units.length
                  ? 'Someone else has applied for it, or it was taken off the market. Choose another one below.'
                  : 'Someone else has applied for it, or it was taken off the market. Nothing else is open right now.'}
              </Alert>
            ) : null}
            <Select
              aria-label="Unit"
              value={unitId}
              onChange={(event) => {
                setGone(false);
                setUnitId(event.target.value);
              }}
              options={[
                { value: '', label: units.length ? 'Choose a unit' : 'Nothing available right now' },
                ...units.map((unit) => ({
                  value: unit.id,
                  label: `${unit.label} · ${unit.suburb} · ${unit.bedrooms} bed`,
                })),
              ]}
            />
            {chosen ? (
              <div className="flex flex-wrap items-end justify-between gap-3 rounded-md bg-brand-50 px-5 py-4">
                <div className="min-w-0">
                  <p className="text-lead font-bold text-ink">{chosen.label}</p>
                  <p className="text-meta text-ink-muted">
                    {chosen.suburb}, {chosen.city} · {chosen.bedrooms} bed · {chosen.bathrooms} bath
                  </p>
                </div>
                <div className="text-right">
                  <p><Money cents={chosen.monthlyRentCents} whole className="text-figure text-ink" /><span className="text-meta text-ink-muted"> a month</span></p>
                  <p className="text-meta text-ink-muted">
                    deposit <Money cents={chosen.depositCents} whole className="text-meta text-ink" />
                  </p>
                </div>
              </div>
            ) : null}
          </section>

          <section className="space-y-4" aria-labelledby="apply-you">
            <h2 id="apply-you" className="text-lead font-bold text-ink">About you</h2>
            <div className="grid grid-cols-2 gap-3">
              <TextField control={control} name="firstName" label="First name" required rules={{ required: 'Needed.' }} />
              <TextField control={control} name="lastName" label="Last name" required rules={{ required: 'Needed.' }} />
            </div>
            <TextField control={control} name="idNumber" label="ID number" inputMode="numeric" required
              hint="The 13 digits on your green ID or smart card."
              rules={{ required: 'Needed.', pattern: { value: /^\d{13}$/, message: 'Exactly 13 digits.' } }} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <TextField control={control} name="email" label="Email" type="email" required />
              <TextField control={control} name="phone" label="Mobile" inputMode="tel" required
                rules={{ required: 'Needed.', minLength: { value: 10, message: 'At least 10 digits.' } }} />
            </div>
          </section>

          <section className="space-y-4" aria-labelledby="apply-work">
            <h2 id="apply-work" className="text-lead font-bold text-ink">Work and income</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <SelectField
                control={control}
                name="employmentStatus"
                label="Employment"
                required
                options={[
                  { label: 'Employed', value: 'employed' },
                  { label: 'Self employed', value: 'self_employed' },
                  { label: 'Contract', value: 'contract' },
                  { label: 'Unemployed', value: 'unemployed' },
                  { label: 'Retired', value: 'retired' },
                ]}
              />
              <TextField control={control} name="employer" label="Employer" />
            </div>
            <TextField
              control={control}
              name="monthlyIncome"
              label="Gross monthly income"
              hint="Before deductions. We check that rent stays under a third of it."
              inputMode="decimal"
              required
              rules={{
                required: 'Needed.',
                validate: (value) => incomeCents(String(value ?? '')) !== null || 'Enter an amount, like 25 000.',
              }}
            />
          </section>

          <section className="space-y-4" aria-labelledby="apply-move">
            <h2 id="apply-move" className="text-lead font-bold text-ink">Moving in</h2>
            <div className="grid grid-cols-2 gap-3">
              <TextField control={control} name="occupants" label="Occupants" inputMode="numeric" required />
              <TextField control={control} name="preferredMoveIn" label="Move in" type="date" required />
            </div>
          </section>

          <section className="space-y-3 border-t border-line pt-5">
            <Checkbox
              id="application-consent"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
              label={
                <span className="text-meta">
                  I agree that the landlord may use my ID number, income and the documents I upload to
                  decide this application, as the{' '}
                  <Link to="/privacy" target="_blank" className={TEXT_LINK}>privacy notice</Link>{' '}
                  explains.
                </span>
              }
            />
            <Checkbox
              id="application-credit-consent"
              checked={creditConsent}
              onChange={(event) => setCreditConsent(event.target.checked)}
              label={
                <span className="text-meta">
                  Optional: the landlord may check my credit record with a registered credit bureau for this application.
                </span>
              }
            />
            <Button block size="lg" loading={formState.isSubmitting} disabled={!consent} onClick={submit}>
              Continue to documents
            </Button>
            {!consent ? (
              <p className="text-center text-meta text-ink-muted">Tick the first box to carry on. Documents come next.</p>
            ) : null}
          </section>
        </div>
      )}
    </AuthLayout>
  );
}
