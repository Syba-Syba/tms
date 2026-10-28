import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router';
import { Button, Card, CardBody, Checkbox, PageHeader, Select, useToast } from '@hlonie/toolbox/ui';
import { SelectField, TextField } from '@hlonie/toolbox/forms';
import { api, humanError } from '../api/client';
import { Ledger } from '../components/money';
import { PRIVACY_VERSION } from '../lib/privacy';
import { incomeCents } from '../lib/income';

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
  const { control, handleSubmit, formState } = useForm<FormValues>();
  const navigate = useNavigate();
  const toast = useToast();
  const [consent, setConsent] = useState(false);
  const [unitId, setUnitId] = useState(
    () => new URLSearchParams(window.location.search).get('unit') ?? '',
  );

  const { data: available } = useQuery({
    queryKey: ['available-units'],
    queryFn: () => api.get<{ items: AvailableUnit[] }>('/units/available'),
  });
  const units = available?.items ?? [];
  const chosen = useMemo(() => units.find((unit) => unit.id === unitId), [units, unitId]);

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
      });
      navigate(`/apply/${created.id}/documents`);
    } catch (error) {
      toast.show({ title: 'Application not sent', description: humanError(error), tone: 'danger' });
    }
  });

  return (
    <main className="mx-auto max-w-lg px-4 py-6">
      <PageHeader
        title="Apply for a unit"
        description="Applying holds the unit for you while the landlord decides."
      />
      <Card className="mb-4">
        <CardBody className="space-y-3">
          <Select
            value={unitId}
            onChange={(event) => setUnitId(event.target.value)}
            options={[
              { value: '', label: units.length ? 'Choose a unit' : 'Nothing available right now' },
              ...units.map((unit) => ({
                value: unit.id,
                label: `${unit.label} · ${unit.suburb} · ${unit.bedrooms} bed`,
              })),
            ]}
          />
          {chosen ? (
            <div className="flex items-end justify-between">
              <div>
                <p className="text-[14.5px] font-semibold">{chosen.label}</p>
                <p className="text-xs text-ink-muted">
                  {chosen.suburb}, {chosen.city} · {chosen.bedrooms} bed · {chosen.bathrooms} bath
                </p>
              </div>
              <div className="text-right">
                <Ledger cents={chosen.monthlyRentCents} className="text-[19px]" />
                <p className="text-xs text-ink-muted">
                  deposit <Ledger cents={chosen.depositCents} className="text-xs" />
                </p>
              </div>
            </div>
          ) : null}
        </CardBody>
      </Card>
      <Card>
        <CardBody className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <TextField control={control} name="firstName" label="First name" required rules={{ required: 'Needed.' }} />
            <TextField control={control} name="lastName" label="Last name" required rules={{ required: 'Needed.' }} />
          </div>
          <TextField control={control} name="idNumber" label="ID number" inputMode="numeric" required
            hint="The 13 digits on your green ID or smart card."
            rules={{ required: 'Needed.', pattern: { value: /^\d{13}$/, message: 'Exactly 13 digits.' } }} />
          <TextField control={control} name="email" label="Email" type="email" required />
          <TextField control={control} name="phone" label="Mobile" inputMode="tel" required
            rules={{ required: 'Needed.', minLength: { value: 10, message: 'At least 10 digits.' } }} />
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
          <div className="grid grid-cols-2 gap-3">
            <TextField control={control} name="occupants" label="Occupants" inputMode="numeric" required />
            <TextField control={control} name="preferredMoveIn" label="Move in" type="date" required />
          </div>
          <Checkbox
            id="application-consent"
            checked={consent}
            onChange={(event) => setConsent(event.target.checked)}
            label={
              <span className="text-[13px]">
                I agree that the landlord may use my ID number, income and the documents I upload to
                decide this application, as the{' '}
                <Link to="/privacy" target="_blank" className="font-bold text-brand-500">privacy notice</Link>{' '}
                explains.
              </span>
            }
          />
          <Button block loading={formState.isSubmitting} disabled={!consent} onClick={submit}>
            Continue to documents
          </Button>
        </CardBody>
      </Card>
    </main>
  );
}
