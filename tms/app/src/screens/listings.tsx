import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { Badge, Card, CardBody, EmptyState, Spinner } from '@hlonie/toolbox/ui';
import { formatZar } from '@hlonie/toolbox/utils';
import { api, errorCode } from '../api/client';
import { formatDate } from '../lib/format';
import { Money } from '../components/money';
import { DoorwayMonogram, Wordmark } from '../components/wordmark';
import { localToday } from '../lib/dates';

interface PublicUnit {
  id: string;
  label: string;
  suburb: string;
  city: string;
  bedrooms: number;
  bathrooms: number;
  monthlyRentCents: number;
  depositCents: number;
  description: string | null;
  availableFrom: string | null;
  furnished: boolean;
  petsAllowed: boolean;
  parkingBays: number;
  photos: string[];
}

interface PublicListings {
  landlord: { name: string; phone: string; email: string; slug: string };
  items: PublicUnit[];
}

const rand = (cents: number) => formatZar(cents / 100).replace(/,00$/, '');

/** Photos scroll sideways, one at a time, the way people expect on a phone. */
function Photos({ photos, label }: { photos: string[]; label: string }) {
  if (photos.length === 0) {
    // No grey slab: a quiet doorway and a line, so a unit without photos still looks cared for.
    return (
      <div className="flex h-28 flex-col items-center justify-center gap-2 border-b border-line-soft bg-surface-muted">
        <span className="h-8 w-6 rounded-t-full border-[1.5px] border-b-0 border-ink-muted/60" aria-hidden />
        <span className="text-xs text-ink-muted">Photos on request</span>
      </div>
    );
  }
  return (
    <div className="relative">
      <div className="flex aspect-[4/3] snap-x snap-mandatory overflow-x-auto" tabIndex={0} aria-label={`Photos of ${label}`}>
        {photos.map((url, index) => (
          <img key={url} src={url} alt={`${label}, photo ${index + 1} of ${photos.length}`} loading={index === 0 ? 'eager' : 'lazy'}
            className="h-full w-full shrink-0 snap-center object-cover" />
        ))}
      </div>
      {photos.length > 1 ? (
        <span className="absolute bottom-2 right-2 rounded-sm bg-black/65 px-2 py-0.5 text-xs font-semibold text-white">
          {photos.length} photos, swipe
        </span>
      ) : null}
    </div>
  );
}

/**
 * A landlord's public listings page, /l/their-name. Anyone can open it from a WhatsApp message
 * or a listing site. Apply goes through sign-up and lands on the application for that unit.
 */
export function Listings() {
  const { slug = '' } = useParams();
  const { data, isLoading, error } = useQuery({
    queryKey: ['listings', slug],
    queryFn: () => api.get<PublicListings>(`/listings?landlord=${encodeURIComponent(slug)}`),
    retry: false,
    // The photo links last an hour; refetching well before keeps a tab left open working.
    staleTime: 30 * 60_000,
    refetchInterval: 45 * 60_000,
  });

  useEffect(() => {
    if (data) document.title = `Rentals from ${data.landlord.name}`;
  }, [data]);

  if (isLoading) {
    return (
      <main className="flex min-h-dvh items-center justify-center">
        <Spinner />
      </main>
    );
  }
  if (!data) {
    const missing = errorCode(error) === 'not_found';
    return (
      <main className="mx-auto max-w-md px-4 py-16">
        <EmptyState
          title={missing ? 'This listings link does not work' : 'The listings could not load'}
          description={missing ? 'Check the link with whoever sent it. The landlord may have changed it.' : 'Check your connection and reload the page.'}
        />
      </main>
    );
  }

  const { landlord, items } = data;
  const today = localToday();
  // Where the places are, from the units themselves: "Sunninghill" or "Melville and Ferndale".
  const suburbs = [...new Set(items.map((unit) => unit.suburb))];
  const areas = suburbs.length === 0 ? '' : suburbs.length === 1 ? suburbs[0] : `${suburbs.slice(0, -1).join(', ')} and ${suburbs.at(-1)}`;

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <header className="mb-8 flex flex-col gap-5 border-b border-line pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex items-end gap-4">
          <DoorwayMonogram name={landlord.name} />
          <div className="min-w-0">
            <p className="label">To let{areas ? ` in ${areas}` : ''}</p>
            <h1 className="font-display text-display font-medium">{landlord.name}</h1>
            <p className="text-body text-ink-muted">
              {items.length === 0 ? 'Nothing vacant right now.' : `${items.length} place${items.length === 1 ? '' : 's'} available.`}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href={`tel:${landlord.phone.replace(/\s/g, '')}`}
            className="inline-flex h-11 items-center rounded-sm border border-line bg-surface px-4 text-body font-semibold text-ink hover:bg-surface-muted">
            Call {landlord.phone}
          </a>
          <a href={`mailto:${landlord.email}`}
            className="inline-flex h-11 items-center rounded-sm border border-line bg-surface px-4 text-body font-semibold text-ink hover:bg-surface-muted">
            Email
          </a>
        </div>
      </header>

      {items.length === 0 ? (
        <EmptyState title="Everything is let" description="Check back later, or get in touch to hear when something comes up." />
      ) : (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          {items.map((unit) => (
            <Card key={unit.id} className="overflow-hidden">
              <Photos photos={unit.photos} label={unit.label} />
              <CardBody className="space-y-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="text-lead font-semibold">{unit.label}</h2>
                    <p className="text-meta text-ink-muted">{unit.suburb}, {unit.city}</p>
                  </div>
                  <p className="text-figure">
                    <Money whole cents={unit.monthlyRentCents} />
                    <span className="ml-1 text-meta font-normal text-ink-muted">a month</span>
                  </p>
                </div>
                <p className="text-meta text-ink">
                  {unit.bedrooms === 0 ? 'Studio' : `${unit.bedrooms} bedroom${unit.bedrooms === 1 ? '' : 's'}`}
                  {' · '}{unit.bathrooms} bathroom{unit.bathrooms === 1 ? '' : 's'}
                  {unit.parkingBays > 0 ? ` · ${unit.parkingBays} parking bay${unit.parkingBays === 1 ? '' : 's'}` : ''}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Badge tone="info">
                    {!unit.availableFrom || unit.availableFrom <= today ? 'Available now' : `From ${formatDate(unit.availableFrom)}`}
                  </Badge>
                  {unit.furnished ? <Badge tone="neutral">Furnished</Badge> : null}
                  {unit.petsAllowed ? <Badge tone="neutral">Pets allowed</Badge> : null}
                </div>
                {unit.description ? (
                  <p className="whitespace-pre-line text-body leading-relaxed text-ink">{unit.description}</p>
                ) : null}
                <p className="text-meta text-ink-muted">Deposit {rand(unit.depositCents)}</p>
                <Link
                  to={`/apply?landlord=${encodeURIComponent(landlord.slug)}&unit=${unit.id}`}
                  className="flex h-11 w-full items-center justify-center rounded-sm bg-action text-body font-semibold text-ink-inverse hover:bg-action-hover"
                >
                  Apply for {unit.label}
                </Link>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <footer className="mt-12 flex flex-col items-center gap-1 border-t border-line pt-6 text-xs text-ink-muted">
        <span className="flex items-center gap-1.5">Listed with <Wordmark small /></span>
        <Link to="/privacy" className="inline-flex min-h-6 items-center underline">How applications handle your information</Link>
      </footer>
    </main>
  );
}
