import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  Badge, Button, Card, CardBody, Checkbox, ConfirmDialog, CurrencyInput, Drawer, EmptyState, Input, PageHeader, Textarea, useToast,
} from '@hlonie/toolbox/ui';
import { ChevronRightIcon } from '@hlonie/toolbox/icons';
import { SelectField, TextField } from '@hlonie/toolbox/forms';
import { copyText } from '@hlonie/toolbox/hooks';
import { useForm } from 'react-hook-form';
import { api, humanError } from '../api/client';
import { pickPhoto, putFile } from '../lib/photos';
import { listingsUrl, useLandlord } from '../lib/landlord';
import { Ledger } from '../components/money';
import { formatDate, status } from '../lib/format';
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
  listing: Listing;
}

interface Listing {
  description: string | null;
  availableFrom: string | null;
  furnished: boolean;
  petsAllowed: boolean;
  parkingBays: number;
  listed: boolean;
  photos: { id: string; url: string }[];
}

const MAX_PHOTOS = 12;

interface Property {
  id: string;
  name: string;
  address: string;
  fields: Record<string, string>;
  units: Unit[];
}

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
  const [editingProperty, setEditingProperty] = useState<Property | null>(null);
  const [addingUnitTo, setAddingUnitTo] = useState<Property | null>(null);
  const [editingUnit, setEditingUnit] = useState<Unit | null>(null);
  const [search, setSearch] = useState('');
  const slug = useLandlord().data?.account.slug ?? null;
  // Ids the landlord has opened or closed by hand; everything else follows the default.
  const [toggled, setToggled] = useState<Set<string>>(new Set());

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['properties'],
    queryFn: () => api.get<{ items: Property[] }>('/properties'),
  });

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

  const needle = search.trim().toLowerCase();
  const shown = needle
    ? items.filter((property) =>
        [property.name, property.address, ...property.units.flatMap((unit) => [unit.code, unit.tenant ?? ''])]
          .join(' ')
          .toLowerCase()
          .includes(needle),
      )
    : items;
  // A short portfolio opens fully; a long one starts folded so it reads as a list of buildings.
  const openByDefault = items.length <= 5 || Boolean(needle);
  const isOpen = (id: string) => (toggled.has(id) ? !openByDefault : openByDefault);
  const toggle = (id: string) =>
    setToggled((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <PageHeader
        title="Properties"
        description={
          totals.length === 0
            ? 'Add your first property to start letting.'
            : `${totals.length} unit${totals.length === 1 ? '' : 's'} · ${occupied.length} occupied`
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {slug ? (
              <a href={listingsUrl(slug)} target="_blank" rel="noreferrer"
                className="inline-flex h-8 items-center rounded-sm border border-line px-3 text-[13px] font-semibold text-ink hover:bg-surface-muted">
                Listings page
              </a>
            ) : null}
            <Button size="sm" onClick={() => setAddingProperty(true)}>Add a property</Button>
          </div>
        }
      />

      {items.length > 3 ? (
        <Input
          className="mb-4"
          placeholder="Search property, address, unit or tenant"
          aria-label="Search properties"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      ) : null}

      {items.length === 0 ? (
        <EmptyState
          title="Nothing here yet"
          description="A property holds its units; applications and leases hang off those."
        />
      ) : shown.length === 0 ? (
        <p className="text-[13px] text-ink-muted">Nothing matches "{search}".</p>
      ) : null}

      <div className="space-y-4">
        {shown.map((property) => {
          const vacant = property.units.filter((unit) => unit.status === 'vacant').length;
          const open = isOpen(property.id);
          return (
            <Card key={property.id}>
              <CardBody className="space-y-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    aria-expanded={open}
                    onClick={() => toggle(property.id)}
                  >
                    <p className="flex items-center gap-2 text-[16px] font-semibold">
                      <ChevronRightIcon className={`shrink-0 text-ink-muted transition-transform ${open ? 'rotate-90' : ''}`} />
                      {property.name}
                    </p>
                    <p className="pl-6 text-xs text-ink-muted">
                      {property.address}
                      <span className="block">
                        {property.units.length} unit{property.units.length === 1 ? '' : 's'}
                        {vacant > 0 ? `, ${vacant} vacant` : property.units.length > 0 ? ', fully let' : ''}
                      </span>
                    </p>
                  </button>
                  <div className="flex shrink-0 items-center gap-2 pl-6 sm:pl-0">
                    <Button size="sm" variant="outline" onClick={() => setAddingUnitTo(property)}>
                      Add a unit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditingProperty(property)}>
                      Edit property
                    </Button>
                  </div>
                </div>

                {open && property.units.length === 0 ? (
                  <p className="text-[13.5px] text-ink-muted">No units yet.</p>
                ) : null}

                {open ? (
                  <div className="space-y-2">
                    {property.units.map((unit) => {
                      const shownStatus = status(unit.status);
                      return (
                        <div
                          key={unit.id}
                          className="flex flex-wrap items-center justify-between gap-2 border-b border-line-soft pb-2 last:border-0 last:pb-0"
                        >
                          <div className="min-w-0">
                            <p className="text-[14.5px] font-semibold">
                              {unit.code}
                              <span className="ml-2 text-xs font-normal text-ink-muted">
                                {unit.bedrooms} bed · {unit.bathrooms} bath
                                {unit.status === 'vacant'
                                  ? unit.listing.listed
                                    ? ` · ${unit.listing.photos.length} photo${unit.listing.photos.length === 1 ? '' : 's'}`
                                    : ' · hidden from listings'
                                  : ''}
                              </span>
                            </p>
                            <p className="text-xs text-ink-muted">
                              {unit.status === 'occupied' && unit.tenant
                                ? `${unit.tenant}${unit.leaseEnd ? ` · until ${formatDate(unit.leaseEnd)}` : ''}`
                                : unit.openApplications > 0
                                  ? `${unit.openApplications} application${unit.openApplications > 1 ? 's' : ''} waiting`
                                  : 'No applications yet'}
                            </p>
                          </div>
                          <div className="flex items-center gap-3">
                            <Ledger cents={unit.monthlyRentCents} className="text-[15px]" />
                            <Badge tone={shownStatus.tone}>{shownStatus.label}</Badge>
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
                      );
                    })}
                  </div>
                ) : null}
              </CardBody>
            </Card>
          );
        })}
      </div>

      <PropertyDrawer
        open={addingProperty}
        property={null}
        onClose={() => setAddingProperty(false)}
        onSaved={() => { setAddingProperty(false); refetch(); }}
      />
      <PropertyDrawer
        open={Boolean(editingProperty)}
        property={editingProperty}
        onClose={() => setEditingProperty(null)}
        onSaved={() => { setEditingProperty(null); refetch(); }}
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
        onPhotosChanged={() => refetch()}
      />
    </main>
  );
}

/** Adds a property, or edits one. Removing lives here too, away from the everyday buttons. */
function PropertyDrawer({ open, property, onClose, onSaved }: {
  open: boolean;
  property: Property | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  // Removing stock is the owner's call; an agent's attempt would be refused anyway.
  const isOwner = useLandlord().data?.me.role === 'owner';
  const { control, handleSubmit, reset, formState } = useForm<PropertyForm>({
    values: property
      ? (property.fields as unknown as PropertyForm)
      : { name: '', addressLine1: '', suburb: '', city: '', province: 'Gauteng', postalCode: '' },
  });

  const submit = handleSubmit(async (values) => {
    try {
      if (property) await api.put(`/properties/${property.id}`, values);
      else await api.post('/properties', values);
      toast.show({ title: property ? 'Property updated' : 'Property added', tone: 'success' });
      reset();
      onSaved();
    } catch (error) {
      toast.show({ title: 'Not saved', description: humanError(error), tone: 'danger' });
    }
  });

  const remove = async () => {
    try {
      await api.delete(`/properties/${property!.id}`);
      toast.show({ title: 'Property removed', tone: 'info' });
      onSaved();
    } catch (error) {
      // The server refuses while units exist; the message says exactly that.
      toast.show({ title: 'Not removed', description: humanError(error), tone: 'danger' });
    } finally {
      setConfirmingRemove(false);
    }
  };

  return (
    <Drawer open={open} onOpenChange={(next) => !next && onClose()} title={property ? `Edit ${property.name}` : 'Add a property'}>
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
        {property && isOwner ? (
          <Button block variant="ghost" onClick={() => setConfirmingRemove(true)}>
            Remove this property
          </Button>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirmingRemove}
        onOpenChange={setConfirmingRemove}
        title={property ? `Remove ${property.name}` : 'Remove'}
        description="A property only goes once it has no units. Nothing with lease history can be removed."
        confirmLabel="Remove"
        onConfirm={remove}
      />
    </Drawer>
  );
}

/** One drawer for both jobs: adding a unit to a property and re-pricing an existing one. */
function UnitDrawer({ property, unit, onClose, onSaved, onPhotosChanged }: {
  property: Property | null;
  unit: Unit | null;
  onClose: () => void;
  onSaved: () => void;
  onPhotosChanged?: () => void;
}) {
  const toast = useToast();
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const isOwner = useLandlord().data?.me.role === 'owner';
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

  const blankListing = { description: '', availableFrom: '', furnished: false, petsAllowed: false, parkingBays: '0', listed: true };
  const [listing, setListing] = useState(blankListing);
  const [photos, setPhotos] = useState<{ id: string; url: string }[]>([]);
  const [photoBusy, setPhotoBusy] = useState<string | null>(null);

  // The drawer is reused across units, so these fields follow whichever unit opens it.
  useEffect(() => {
    setRentCents(unit?.monthlyRentCents ?? 0);
    setDepositCents(unit?.depositCents ?? 0);
    setListing(
      unit
        ? {
            description: unit.listing.description ?? '',
            availableFrom: unit.listing.availableFrom ?? '',
            furnished: unit.listing.furnished,
            petsAllowed: unit.listing.petsAllowed,
            parkingBays: String(unit.listing.parkingBays),
            listed: unit.listing.listed,
          }
        : blankListing,
    );
    setPhotos(unit?.listing.photos ?? []);
  }, [unit?.id]);

  const addPhoto = async () => {
    if (!unit) return;
    try {
      // Redrawn through a canvas on the phone: capped in size, and without the EXIF block,
      // so no camera location reaches a public page.
      const photo = await pickPhoto({ maxEdge: 1600, quality: 0.75 });
      if (!photo) return;
      setPhotoBusy('adding');
      const { uploadUrl, photoId } = await api.post<{ uploadUrl: string; photoId: string }>(`/units/${unit.id}/photos`, {
        contentType: photo.contentType,
        sizeBytes: photo.blob.size,
      });
      await putFile(uploadUrl, photo.blob, photo.contentType);
      await api.post('/photos/confirm', { scope: 'unit', photoId });
      setPhotos((current) => [...current, { id: photoId, url: photo.dataUrl }]);
      onPhotosChanged?.();
    } catch (error) {
      toast.show({ title: 'Photo not added', description: humanError(error), tone: 'danger' });
    } finally {
      setPhotoBusy(null);
    }
  };

  const removePhoto = async (photoId: string) => {
    setPhotoBusy(photoId);
    try {
      await api.delete(`/units/${unit!.id}/photos/${photoId}`);
      setPhotos((current) => current.filter((photo) => photo.id !== photoId));
      onPhotosChanged?.();
    } catch (error) {
      toast.show({ title: 'Photo not removed', description: humanError(error), tone: 'danger' });
    } finally {
      setPhotoBusy(null);
    }
  };

  const parking = Number(listing.parkingBays);
  const listingValid = Number.isInteger(parking) && parking >= 0 && parking <= 10 && listing.description.length <= 2000;

  const submit = handleSubmit(async (values) => {
    if (rentCents <= 0) {
      toast.show({ title: 'Set the rent', tone: 'warning' });
      return;
    }
    if (!listingValid) {
      toast.show({ title: 'Parking bays is a number from 0 to 10', tone: 'warning' });
      return;
    }
    const body = {
      code: values.code,
      bedrooms: Number(values.bedrooms),
      bathrooms: Number(values.bathrooms),
      monthlyRentCents: rentCents,
      depositCents,
      ...(unit
        ? {
            description: listing.description.trim() || null,
            availableFrom: listing.availableFrom || null,
            furnished: listing.furnished,
            petsAllowed: listing.petsAllowed,
            parkingBays: parking,
            listed: listing.listed,
          }
        : {}),
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
        {unit ? (
          <section aria-label="Listing" className="space-y-3 border-t border-line pt-4">
            <div>
              <p className="text-[14px] font-semibold">Listing</p>
              <p className="text-xs text-ink-muted">What applicants see on your listings page while the unit is vacant.</p>
            </div>
            <div>
              <p className="mb-1 text-[13px] font-medium">Photos</p>
              <div className="grid grid-cols-3 gap-2">
                {photos.map((photo) => (
                  <div key={photo.id} className="relative aspect-[4/3] overflow-hidden rounded-sm border border-line bg-surface-muted">
                    <img src={photo.url} alt="" className="h-full w-full object-cover" />
                    <button type="button" aria-label="Remove this photo" disabled={photoBusy !== null}
                      className="absolute right-1 top-1 rounded-sm bg-black/65 px-1.5 py-0.5 text-[12px] font-semibold text-white"
                      onClick={() => removePhoto(photo.id)}>
                      {photoBusy === photo.id ? '…' : 'Remove'}
                    </button>
                  </div>
                ))}
                {photos.length < MAX_PHOTOS ? (
                  <button type="button" disabled={photoBusy !== null} onClick={addPhoto}
                    className="flex aspect-[4/3] items-center justify-center rounded-sm border border-dashed border-line text-[13px] font-semibold text-brand-500">
                    {photoBusy === 'adding' ? 'Uploading…' : 'Add a photo'}
                  </button>
                ) : null}
              </div>
              <p className="mt-1 text-xs text-ink-muted">Up to {MAX_PHOTOS}. The first one leads the listing.</p>
            </div>
            <div>
              <label htmlFor="unit-description" className="mb-1 block text-[13px] font-medium">Description</label>
              <Textarea id="unit-description" rows={4} maxLength={2000} value={listing.description}
                placeholder="Light, quiet, close to the Gautrain. Prepaid electricity, water included."
                onChange={(event) => setListing({ ...listing, description: event.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="unit-available" className="mb-1 block text-[13px] font-medium">Available from</label>
                <Input id="unit-available" type="date" value={listing.availableFrom}
                  onChange={(event) => setListing({ ...listing, availableFrom: event.target.value })} />
              </div>
              <div>
                <label htmlFor="unit-parking" className="mb-1 block text-[13px] font-medium">Parking bays</label>
                <Input id="unit-parking" inputMode="numeric" value={listing.parkingBays}
                  onChange={(event) => setListing({ ...listing, parkingBays: event.target.value.replace(/\D/g, '').slice(0, 2) })} />
              </div>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              <Checkbox id="unit-furnished" checked={listing.furnished} label="Furnished"
                onChange={(event) => setListing({ ...listing, furnished: event.target.checked })} />
              <Checkbox id="unit-pets" checked={listing.petsAllowed} label="Pets allowed"
                onChange={(event) => setListing({ ...listing, petsAllowed: event.target.checked })} />
            </div>
            <Checkbox id="unit-listed" checked={listing.listed} label="Show on my listings page when vacant"
              onChange={(event) => setListing({ ...listing, listed: event.target.checked })} />
          </section>
        ) : null}
        <Button block loading={formState.isSubmitting} onClick={submit}>Save</Button>
        {unit && isOwner ? (
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
