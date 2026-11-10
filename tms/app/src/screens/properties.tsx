import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Avatar, Badge, Button, Card, Checkbox, ConfirmDialog, CurrencyInput, Drawer, EmptyState, Input, PageHeader, Textarea, useToast,
} from '@hlonie/toolbox/ui';
import { ChevronRightIcon } from '@hlonie/toolbox/icons';
import { SelectField, TextField } from '@hlonie/toolbox/forms';
import { copyText } from '@hlonie/toolbox/hooks';
import { useForm } from 'react-hook-form';
import { api, humanError } from '../api/client';
import { pickPhoto, putFile } from '../lib/photos';
import { listingsUrl, useLandlord } from '../lib/landlord';
import { Money } from '../components/money';
import { formatDate, status } from '../lib/format';
import { QueryState } from '../components/query-state';
import { PAGE } from '../lib/layout';
import { ListsLinkButton, ListsTile, ListsTiles, listsButtonClass } from '../components/lists-kit';

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
  const queryClient = useQueryClient();
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
    // Without the landlord, a server with more than one landlord shows no form at all.
    if (!slug) return;
    const link = `${window.location.origin}/apply?landlord=${encodeURIComponent(slug)}&unit=${unit.id}`;
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

  const vacantUnits = totals.filter((unit) => unit.status === 'vacant');
  const heldUnits = totals.filter((unit) => unit.status === 'held');
  const waiting = totals.reduce((sum, unit) => sum + unit.openApplications, 0);
  // Asking rent of the let units: a signed lease keeps its own figure, shown on the lease.
  const rentRollCents = occupied.reduce((sum, unit) => sum + unit.monthlyRentCents, 0);
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const propertyCount = items.length === 1 ? '1 property' : `${items.length} properties`;
  // A save here also moves the setup checklist (first property, first unit) on the overview.
  const saved = () => {
    void refetch();
    void queryClient.invalidateQueries({ queryKey: ['landlord'] });
  };

  return (
    <main className={PAGE.wide}>
      <PageHeader
        title="Properties"
        description={
          totals.length === 0
            ? 'Add your first property to start letting.'
            : `${propertyCount}, ${plural(totals.length, 'unit')}`
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {slug ? (
              <a href={listingsUrl(slug)} target="_blank" rel="noreferrer" className={listsButtonClass('outline', 'md')}>
                Listings page
              </a>
            ) : null}
            <Button onClick={() => setAddingProperty(true)}>Add a property</Button>
          </div>
        }
      />

      {totals.length > 0 ? (
        <ListsTiles>
          <ListsTile label="Units" value={totals.length} note={`in ${propertyCount}`} />
          <ListsTile
            label="Occupied"
            value={`${occupied.length} of ${totals.length}`}
            note={heldUnits.length > 0 ? `${heldUnits.length} more held for an approved applicant` : 'with a signed lease'}
          />
          <ListsTile
            label="Vacant"
            value={vacantUnits.length}
            note={
              vacantUnits.length === 0
                ? 'Nothing standing empty'
                : waiting > 0
                  ? `${plural(waiting, 'application')} waiting`
                  : 'No applications yet'
            }
          />
          <ListsTile label="Monthly rent roll" value={<Money whole cents={rentRollCents} />} note={`from ${plural(occupied.length, 'let unit')}`} />
        </ListsTiles>
      ) : null}

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
          title="No properties yet"
          description="A property is a building or a house. Its units show here with who rents them, the rent and what is vacant."
          action={<Button onClick={() => setAddingProperty(true)}>Add your first property</Button>}
        />
      ) : shown.length === 0 ? (
        <p className="text-body text-ink-muted">Nothing matches "{search}".</p>
      ) : null}

      <div className="space-y-5">
        {shown.map((property) => {
          const vacant = property.units.filter((unit) => unit.status === 'vacant').length;
          const open = isOpen(property.id);
          return (
            <Card key={property.id} className="overflow-hidden">
              <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <button
                  type="button"
                  className="min-w-0 flex-1 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tb-ring)]"
                  aria-expanded={open}
                  onClick={() => toggle(property.id)}
                >
                  <span className="flex items-center gap-2 text-title font-bold text-ink">
                    <ChevronRightIcon className={`shrink-0 text-ink-muted transition-transform ${open ? 'rotate-90' : ''}`} />
                    {property.name}
                  </span>
                  <span className="mt-0.5 block pl-6 text-meta text-ink-muted">{property.address}</span>
                  <span className="mt-2 flex flex-wrap gap-1.5 pl-6">
                    <Badge tone="neutral">{plural(property.units.length, 'unit')}</Badge>
                    {vacant > 0 ? (
                      <Badge tone="warning">{vacant} vacant</Badge>
                    ) : property.units.length > 0 ? (
                      <Badge tone="success">Fully let</Badge>
                    ) : null}
                  </span>
                </button>
                <div className="flex shrink-0 items-center gap-2 pl-6 sm:pl-0">
                  <Button size="sm" variant="secondary" onClick={() => setAddingUnitTo(property)}>
                    Add a unit
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEditingProperty(property)}>
                    Edit property
                  </Button>
                </div>
              </div>

              {open && property.units.length === 0 ? (
                <p className="border-t border-line-soft px-5 py-4 text-body text-ink-muted">
                  No units yet. Add one to set its rent and take applications.
                </p>
              ) : null}

              {open && property.units.length > 0 ? (
                <div className="divide-y divide-line-soft border-t border-line-soft">
                  {property.units.map((unit) => {
                    const shownStatus = status(unit.status);
                    return (
                      <div key={unit.id} className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-3.5">
                        <div className="w-24 shrink-0">
                          <p className="break-words text-title font-bold text-ink">{unit.code}</p>
                          <p className="text-meta text-ink-muted">{unit.bedrooms} bed · {unit.bathrooms} bath</p>
                        </div>

                        {unit.status === 'occupied' && unit.tenant ? (
                          <div className="flex min-w-0 flex-1 basis-44 items-center gap-3">
                            <Avatar name={unit.tenant} />
                            <div className="min-w-0">
                              <p className="truncate text-body font-semibold text-ink">{unit.tenant}</p>
                              {unit.leaseEnd ? <p className="text-meta text-ink-muted">Lease until {formatDate(unit.leaseEnd)}</p> : null}
                            </div>
                          </div>
                        ) : (
                          <div className="min-w-0 flex-1 basis-44">
                            <p className="text-body font-semibold text-ink">
                              {unit.status === 'held' ? 'Held for an approved applicant' : 'Vacant'}
                            </p>
                            <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-meta text-ink-muted">
                              {unit.openApplications > 0
                                ? `${plural(unit.openApplications, 'application')} waiting`
                                : unit.status === 'held' ? 'The lease is being signed' : 'No applications yet'}
                              {unit.status === 'vacant' ? (
                                unit.listing.listed
                                  ? <Badge tone="neutral">{unit.listing.photos.length === 0 ? 'No photos yet' : plural(unit.listing.photos.length, 'photo')}</Badge>
                                  : <Badge tone="neutral">Hidden from listings</Badge>
                              ) : null}
                            </p>
                          </div>
                        )}

                        <div className="flex items-center gap-3 lg:w-52 lg:justify-end">
                          <Money whole cents={unit.monthlyRentCents} className="text-lead text-ink" />
                          <Badge tone={shownStatus.tone}>{shownStatus.label}</Badge>
                        </div>

                        <div className="flex w-full flex-wrap gap-2 lg:w-72 lg:justify-end">
                          {unit.status === 'occupied' && unit.leaseId ? (
                            <ListsLinkButton to={`/leases/${unit.leaseId}`} aria-label={`Lease for ${unit.code}`}>
                              Open lease
                            </ListsLinkButton>
                          ) : null}
                          {unit.status !== 'occupied' && unit.openApplications > 0 ? (
                            <ListsLinkButton to="/applications" variant="secondary" aria-label={`Review applications for ${unit.code}`}>
                              Review
                            </ListsLinkButton>
                          ) : null}
                          {/* Only a vacant unit takes applications; a held one has its applicant. */}
                          {unit.status === 'vacant' ? (
                            <Button
                              size="sm"
                              variant="outline"
                              aria-label={`Copy the application link for ${unit.code}`}
                              disabled={!slug}
                              onClick={() => copyApplicationLink(unit)}
                            >
                              Copy apply link
                            </Button>
                          ) : null}
                          <Button size="sm" variant="outline" aria-label={`Edit ${unit.code}`} onClick={() => setEditingUnit(unit)}>
                            Edit
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </Card>
          );
        })}
      </div>

      <PropertyDrawer
        open={addingProperty}
        property={null}
        onClose={() => setAddingProperty(false)}
        onSaved={() => { setAddingProperty(false); saved(); }}
      />
      <PropertyDrawer
        open={Boolean(editingProperty)}
        property={editingProperty}
        onClose={() => setEditingProperty(null)}
        onSaved={() => { setEditingProperty(null); saved(); }}
      />
      <UnitDrawer
        property={addingUnitTo}
        unit={null}
        onClose={() => setAddingUnitTo(null)}
        onSaved={() => { setAddingUnitTo(null); saved(); }}
      />
      <UnitDrawer
        property={null}
        unit={editingUnit}
        onClose={() => setEditingUnit(null)}
        onSaved={() => { setEditingUnit(null); saved(); }}
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
  const [removing, setRemoving] = useState(false);
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
    // One removal at a time: a second tap used to send a second DELETE and a false "Not removed".
    if (removing) return;
    setRemoving(true);
    try {
      await api.delete(`/properties/${property!.id}`);
      toast.show({ title: 'Property removed', tone: 'info' });
      onSaved();
    } catch (error) {
      // The server refuses while units exist; the message says exactly that.
      toast.show({ title: 'Not removed', description: humanError(error), tone: 'danger' });
    } finally {
      setRemoving(false);
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
          <Button block variant="outline" onClick={() => setConfirmingRemove(true)}>
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
        loading={removing}
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
  const [removing, setRemoving] = useState(false);
  const isOwner = useLandlord().data?.me.role === 'owner';
  const open = Boolean(property || unit);

  const remove = async () => {
    if (removing) return;
    setRemoving(true);
    try {
      await api.delete(`/units/${unit!.id}`);
      toast.show({ title: 'Unit removed', tone: 'info' });
      onSaved();
    } catch (error) {
      // Lease history or applications on file: the server explains which.
      toast.show({ title: 'Not removed', description: humanError(error), tone: 'danger' });
    } finally {
      setRemoving(false);
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

  // The drawer is reused across units, so these fields follow whichever unit opens it. Adding
  // has no unit id (null every time), so keying on it alone kept the last unit's rent and
  // deposit in a fresh Add-unit drawer; the property and each opening reset it too.
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
  }, [unit?.id, property?.id, open]);

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
          <p className="mb-1 text-meta font-semibold text-ink" aria-hidden>Monthly rent</p>
          <CurrencyInput aria-label="Monthly rent" cents={rentCents} onCentsChange={(next) => setRentCents(next ?? 0)} />
        </div>
        <div>
          <p className="mb-1 text-meta font-semibold text-ink" aria-hidden>Deposit</p>
          <CurrencyInput aria-label="Deposit" cents={depositCents} onCentsChange={(next) => setDepositCents(next ?? 0)} />
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
              <p className="text-lead font-bold text-ink">Listing</p>
              <p className="text-xs text-ink-muted">What applicants see on your listings page while the unit is vacant.</p>
            </div>
            <div>
              <p className="mb-1 text-meta font-semibold">Photos</p>
              <div className="grid grid-cols-3 gap-2">
                {photos.map((photo) => (
                  <div key={photo.id} className="relative aspect-[4/3] overflow-hidden rounded-sm border border-line bg-surface-muted">
                    <img src={photo.url} alt="" className="h-full w-full object-cover" />
                    <button type="button" aria-label="Remove this photo" disabled={photoBusy !== null}
                      className="absolute right-1 top-1 rounded-sm bg-black/65 px-1.5 py-0.5 text-xs font-semibold text-white"
                      onClick={() => removePhoto(photo.id)}>
                      {photoBusy === photo.id ? '…' : 'Remove'}
                    </button>
                  </div>
                ))}
                {photos.length < MAX_PHOTOS ? (
                  <button type="button" disabled={photoBusy !== null} onClick={addPhoto}
                    className="flex aspect-[4/3] items-center justify-center rounded-sm border-2 border-dashed border-brand-200 bg-brand-50 text-meta font-semibold text-brand-600 hover:border-brand-500">
                    {photoBusy === 'adding' ? 'Uploading…' : 'Add a photo'}
                  </button>
                ) : null}
              </div>
              <p className="mt-1 text-xs text-ink-muted">Up to {MAX_PHOTOS}. The first one leads the listing.</p>
            </div>
            <div>
              <label htmlFor="unit-description" className="mb-1 block text-meta font-semibold">Description</label>
              <Textarea id="unit-description" rows={4} maxLength={2000} value={listing.description}
                placeholder="Light, quiet, close to the Gautrain. Prepaid electricity, water included."
                onChange={(event) => setListing({ ...listing, description: event.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="unit-available" className="mb-1 block text-meta font-semibold">Available from</label>
                <Input id="unit-available" type="date" value={listing.availableFrom}
                  onChange={(event) => setListing({ ...listing, availableFrom: event.target.value })} />
              </div>
              <div>
                <label htmlFor="unit-parking" className="mb-1 block text-meta font-semibold">Parking bays</label>
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
          <Button block variant="outline" onClick={() => setConfirmingRemove(true)}>
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
        loading={removing}
        onConfirm={remove}
      />
    </Drawer>
  );
}
