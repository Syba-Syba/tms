import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  Badge, Button, Card, CardBody, ConfirmDialog, CurrencyInput, Drawer, EmptyState, PageHeader, useToast,
} from '@hlonie/toolbox/ui';
import { SelectField, TextField } from '@hlonie/toolbox/forms';
import { copyText } from '@hlonie/toolbox/hooks';
import { useForm } from 'react-hook-form';
import { api, humanError } from '../api/client';
import { Ledger } from '../components/money';
import { QueryState } from '../components/query-state';

interface Unit {
  id: string;
  code: string;
  bedrooms: number;
  bathrooms: number;
  monthlyRentCents: number;
  depositCents: number;
  status: 'vacant' | 'held' | 'occupied';
  tenant: string | null;
  leaseId: string | null;
  leaseEnd: string | null;
  openApplications: number;
}

interface Property {
  id: string;
  name: string;
  address: string;
  units: Unit[];
}

const STATUS_TONE = { vacant: 'warning', held: 'info', occupied: 'success' } as const;

interface PropertyForm {
  name: string;
  addressLine1: string;
  suburb: string;
  city: string;
  province: string;
  postalCode: string;
}

interface UnitForm {
  code: string;
  bedrooms: string;
  bathrooms: string;
}

const PROVINCES = [
  'Eastern Cape', 'Free State', 'Gauteng', 'KwaZulu-Natal', 'Limpopo',
  'Mpumalanga', 'North West', 'Northern Cape', 'Western Cape',
].map((province) => ({ label: province, value: province }));

export function Properties() {
  const toast = useToast();
  const [addingProperty, setAddingProperty] = useState(false);
  const [addingUnitTo, setAddingUnitTo] = useState<Property | null>(null);
  const [editingUnit, setEditingUnit] = useState<Unit | null>(null);
  const [removingProperty, setRemovingProperty] = useState<Property | null>(null);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['properties'],
    queryFn: () => api.get<{ items: Property[] }>('/properties'),
  });

  const removeProperty = async (property: Property) => {
    try {
      await api.delete(`/properties/${property.id}`);
      toast.show({ title: 'Property removed', tone: 'info' });
      refetch();
    } catch (error) {
      // The server refuses while units exist; the message says exactly that.
      toast.show({ title: 'Not removed', description: humanError(error), tone: 'danger' });
    } finally {
      setRemovingProperty(null);
    }
  };

  const copyApplicationLink = async (unit: Unit) => {
    const link = `${window.location.origin}/apply?unit=${unit.id}`;
    // Over plain HTTP there is no navigator.clipboard; copyText falls back to the selection
    // API, and when even that fails the link is shown so it can be copied by hand.
    if (await copyText(link)) {
      toast.show({
        title: 'Application link copied',
        description: 'Send it to anyone interested; the form opens on this unit.',
        tone: 'success',
      });
    } else {
      toast.show({
        title: 'Could not copy automatically',
        description: `Copy this link by hand: ${link}`,
        tone: 'warning',
        duration: 15000,
      });
    }
  };

  if (!data) {
    return <QueryState isLoading={isLoading} isError={isError} error={error} onRetry={refetch} what="Your properties" />;
  }
  const items = data?.items ?? [];
  const totals = items.flatMap((property) => property.units);
  const occupied = totals.filter((unit) => unit.status === 'occupied');

  return (
    <main className="mx-auto max-w-5xl px-6 py-6">
      <PageHeader
        title="Properties"
        description={
          totals.length === 0
            ? 'Add your first property to start letting.'
            : `${totals.length} unit${totals.length === 1 ? '' : 's'} · ${occupied.length} occupied`
        }
        actions={<Button size="sm" onClick={() => setAddingProperty(true)}>Add a property</Button>}
      />

      {items.length === 0 ? (
        <EmptyState
          title="Nothing here yet"
          description="A property holds its units; applications and leases hang off those."
        />
      ) : null}

      <div className="space-y-4">
        {items.map((property) => (
          <Card key={property.id}>
            <CardBody className="space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-[16px] font-semibold">{property.name}</p>
                  <p className="text-xs text-ink-muted">{property.address}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => setAddingUnitTo(property)}>
                    Add a unit
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setRemovingProperty(property)}>
                    Remove
                  </Button>
                </div>
              </div>

              {property.units.length === 0 ? (
                <p className="text-[13.5px] text-ink-muted">No units yet.</p>
              ) : null}

              <div className="space-y-2">
                {property.units.map((unit) => (
                  <div
                    key={unit.id}
                    className="flex flex-wrap items-center justify-between gap-2 border-b border-line-soft pb-2 last:border-0 last:pb-0"
                  >
                    <div>
                      <p className="text-[14.5px] font-semibold">
                        {unit.code}
                        <span className="ml-2 text-xs font-normal text-ink-muted">
                          {unit.bedrooms} bed · {unit.bathrooms} bath
                        </span>
                      </p>
                      <p className="text-xs text-ink-muted">
                        {unit.status === 'occupied' && unit.tenant
                          ? `${unit.tenant}${unit.leaseEnd ? ` · until ${unit.leaseEnd}` : ''}`
                          : unit.openApplications > 0
                            ? `${unit.openApplications} application${unit.openApplications > 1 ? 's' : ''} waiting`
                            : 'No applications yet'}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <Ledger cents={unit.monthlyRentCents} className="text-[15px]" />
                      <Badge tone={STATUS_TONE[unit.status]}>{unit.status}</Badge>
                      {unit.status === 'occupied' && unit.leaseId ? (
                        <Link
                          to={`/leases/${unit.leaseId}`}
                          className="text-[13px] font-bold text-brand-500"
                        >
                          Lease
                        </Link>
                      ) : (
                        <button
                          type="button"
                          className="text-[13px] font-bold text-brand-500"
                          onClick={() => copyApplicationLink(unit)}
                        >
                          Copy link
                        </button>
                      )}
                      <button
                        type="button"
                        className="text-[13px] font-semibold text-ink-muted hover:text-ink"
                        onClick={() => setEditingUnit(unit)}
                      >
                        Edit
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </CardBody>
          </Card>
        ))}
      </div>

      <AddPropertyDrawer
        open={addingProperty}
        onClose={() => setAddingProperty(false)}
        onSaved={() => { setAddingProperty(false); refetch(); }}
      />
      <UnitDrawer
        property={addingUnitTo}
        unit={null}
        onClose={() => setAddingUnitTo(null)}
        onSaved={() => { setAddingUnitTo(null); refetch(); }}
      />
      <UnitDrawer
        property={null}
        unit={editingUnit}
        onClose={() => setEditingUnit(null)}
        onSaved={() => { setEditingUnit(null); refetch(); }}
      />
      <ConfirmDialog
        open={!!removingProperty}
        onOpenChange={() => setRemovingProperty(null)}
        title={removingProperty ? `Remove ${removingProperty.name}` : 'Remove'}
        description="A property only goes once it has no units. Nothing with lease history can be removed."
        confirmLabel="Remove"
        onConfirm={() => removingProperty && removeProperty(removingProperty)}
      />
    </main>
  );
}

function AddPropertyDrawer({ open, onClose, onSaved }: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const { control, handleSubmit, reset, formState } = useForm<PropertyForm>({
    defaultValues: { province: 'Gauteng' },
  });

  const submit = handleSubmit(async (values) => {
    try {
      await api.post('/properties', values);
      toast.show({ title: 'Property added', tone: 'success' });
      reset();
      onSaved();
    } catch (error) {
      toast.show({ title: 'Not saved', description: humanError(error), tone: 'danger' });
    }
  });

  return (
    <Drawer open={open} onOpenChange={(next) => !next && onClose()} title="Add a property">
      <div className="space-y-3">
        <TextField
          control={control}
          name="name"
          label="Name"
          hint="How you refer to it, e.g. Kruis Court."
          required
          rules={{ required: 'Give the property a name.', minLength: { value: 2, message: 'At least 2 characters.' } }}
        />
        <TextField
          control={control}
          name="addressLine1"
          label="Street address"
          required
          rules={{ required: 'The street address is needed.', minLength: { value: 3, message: 'At least 3 characters.' } }}
        />
        <div className="grid grid-cols-2 gap-3">
          <TextField control={control} name="suburb" label="Suburb" required
            rules={{ required: 'Needed.', minLength: { value: 2, message: 'At least 2 characters.' } }} />
          <TextField control={control} name="city" label="City" required
            rules={{ required: 'Needed.', minLength: { value: 2, message: 'At least 2 characters.' } }} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <SelectField control={control} name="province" label="Province" options={PROVINCES} required />
          <TextField control={control} name="postalCode" label="Postal code" inputMode="numeric" required
            rules={{ required: 'Needed.', pattern: { value: /^\d{4}$/, message: 'Four digits, e.g. 2194.' } }} />
        </div>
        <Button block loading={formState.isSubmitting} onClick={submit}>Save</Button>
      </div>
    </Drawer>
  );
}

/** One drawer for both jobs: adding a unit to a property and re-pricing an existing one. */
function UnitDrawer({ property, unit, onClose, onSaved }: {
  property: Property | null;
  unit: Unit | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const open = Boolean(property || unit);

  const remove = async () => {
    try {
      await api.delete(`/units/${unit!.id}`);
      toast.show({ title: 'Unit removed', tone: 'info' });
      onSaved();
    } catch (error) {
      // Lease history or applications on file: the server explains which.
      toast.show({ title: 'Not removed', description: humanError(error), tone: 'danger' });
    } finally {
      setConfirmingRemove(false);
    }
  };
  const [rentCents, setRentCents] = useState(unit?.monthlyRentCents ?? 0);
  const [depositCents, setDepositCents] = useState(unit?.depositCents ?? 0);
  const { control, handleSubmit, formState } = useForm<UnitForm>({
    values: {
      code: unit?.code ?? '',
      bedrooms: String(unit?.bedrooms ?? 2),
      bathrooms: String(unit?.bathrooms ?? 1),
    },
  });

  // The drawer is reused across units, so the money fields follow whichever unit opens it.
  useEffect(() => {
    setRentCents(unit?.monthlyRentCents ?? 0);
    setDepositCents(unit?.depositCents ?? 0);
  }, [unit?.id]);

  const submit = handleSubmit(async (values) => {
    if (rentCents <= 0) {
      toast.show({ title: 'Set the rent', tone: 'warning' });
      return;
    }
    const body = {
      code: values.code,
      bedrooms: Number(values.bedrooms),
      bathrooms: Number(values.bathrooms),
      monthlyRentCents: rentCents,
      depositCents,
    };
    try {
      if (unit) await api.put(`/units/${unit.id}`, body);
      else await api.post(`/properties/${property!.id}/units`, body);
      toast.show({ title: unit ? 'Unit updated' : 'Unit added', tone: 'success' });
      onSaved();
    } catch (error) {
      toast.show({ title: 'Not saved', description: humanError(error), tone: 'danger' });
    }
  });

  return (
    <Drawer
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={unit ? `Edit ${unit.code}` : `Add a unit to ${property?.name ?? ''}`}
    >
      <div className="space-y-3">
        <TextField control={control} name="code" label="Unit code" hint="A1, G2, Cottage." required />
        <div className="grid grid-cols-2 gap-3">
          <TextField control={control} name="bedrooms" label="Bedrooms" inputMode="numeric" required />
          <TextField control={control} name="bathrooms" label="Bathrooms" inputMode="numeric" required />
        </div>
        <div>
          <p className="mb-1 text-[13px] font-medium">Monthly rent</p>
          <CurrencyInput cents={rentCents} onCentsChange={(next) => setRentCents(next ?? 0)} />
        </div>
        <div>
          <p className="mb-1 text-[13px] font-medium">Deposit</p>
          <CurrencyInput cents={depositCents} onCentsChange={(next) => setDepositCents(next ?? 0)} />
          <p className="mt-1 text-xs text-ink-muted">
            Usually one month. It sits in a ledger and earns the tenant interest.
          </p>
        </div>
        {unit && unit.status !== 'vacant' ? (
          <p className="text-xs text-ink-muted">
            The signed lease keeps its own rent. This changes what the next applicant sees.
          </p>
        ) : null}
        <Button block loading={formState.isSubmitting} onClick={submit}>Save</Button>
        {unit ? (
          <Button block variant="ghost" onClick={() => setConfirmingRemove(true)}>
            Remove this unit
          </Button>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirmingRemove}
        onOpenChange={setConfirmingRemove}
        title={unit ? `Remove ${unit.code}` : 'Remove'}
        description="Only a unit with no lease history and no applications can be removed. Anything with a paper trail stays."
        confirmLabel="Remove"
        onConfirm={remove}
      />
    </Drawer>
  );
}
