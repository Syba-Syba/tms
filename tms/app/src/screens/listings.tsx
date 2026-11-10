import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { Badge, Card, CardBody, EmptyState, Spinner } from '@hlonie/toolbox/ui';
import { formatZar } from '@hlonie/toolbox/utils';
import { api, errorCode } from '../api/client';
import { formatDate } from '../lib/format';
import { Money } from '../components/money';
import { DoorwayMonogram, Wordmark } from '../components/wordmark';
import { ListsDoorway, listsButtonClass } from '../components/lists-kit';
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
  // Contact details are null while the landlord has nothing listed: the server keeps them private.
  landlord: { name: string; phone: string | null; email: string | null; slug: string };
  items: PublicUnit[];
}

const rand = (cents: number) => formatZar(cents / 100).replace(/,00$/, '');

/** Photos scroll sideways, one at a time, the way people expect on a phone. */
function Photos({ photos, label }: { photos: string[]; label: string }) {
  if (photos.length === 0) {
    // No grey slab: a green-tinted panel with the doorway mark, so a unit without photos still looks cared for.
    return (
      <div className="flex aspect-[16/9] flex-col items-center justify-center gap-3 bg-brand-50 text-brand-500">
        <ListsDoorway className="h-14 w-10" />
        <span className="text-meta font-semibold text-brand-700">Photos on request</span>
      </div>
    );
  }
  return (
    <div className="relative">
      <div className="flex aspect-[16/9] snap-x snap-mandatory overflow-x-auto" tabIndex={0} aria-label={`Photos of ${label}`}>
        {photos.map((url, index) => (
          <img key={url} src={url} alt={`${label}, photo ${index + 1} of ${photos.length}`} loading={index === 0 ? 'eager' : 'lazy'}
            className="h-full w-full shrink-0 snap-center object-cover" />
        ))}
      </div>
      {photos.length > 1 ? (
        <span className="absolute bottom-2 right-2 rounded-full bg-black/65 px-2.5 py-1 text-xs font-semibold text-white">
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

  const contact = (
    <>
      {landlord.phone ? (
        <a href={`tel:${landlord.phone.replace(/\s/g, '')}`} className={listsButtonClass('outline', 'md')}>
          Call {landlord.phone}
        </a>
      ) : null}
      {landlord.email ? (
        <a href={`mailto:${landlord.email}`} className={listsButtonClass('outline', 'md')}>
          Email
        </a>
      ) : null}
    </>
  );
  const hasContact = Boolean(landlord.phone || landlord.email);

  return (
    <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
      <header className="mb-8 flex flex-col gap-5 rounded-lg bg-brand-50 px-5 py-6 sm:flex-row sm:items-center sm:justify-between sm:px-8 sm:py-8">
        <div className="flex items-center gap-4">
          <DoorwayMonogram name={landlord.name} />
          <div className="min-w-0">
            <p className="text-meta font-semibold text-brand-700">To let{areas ? ` in ${areas}` : ''}</p>
            <h1 className="font-display text-display font-bold text-ink">{landlord.name}</h1>
            <p className="mt-1 text-body text-ink-muted">
              {items.length === 0 ? 'Nothing vacant right now.' : `${items.length} place${items.length === 1 ? '' : 's'} available. Apply online in a few minutes.`}
            </p>
          </div>
        </div>
        {hasContact ? <div className="flex flex-wrap gap-2">{contact}</div> : null}
      </header>

      {items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-line bg-surface px-6 py-12 text-center shadow-sm">
          <span className="text-brand-500"><ListsDoorway className="h-14 w-10" /></span>
          <h2 className="text-title font-bold text-ink">Everything is let</h2>
          <p className="max-w-prose text-body text-ink-muted">
            {hasContact
              ? 'Places that come up for rent show on this page. Check back later, or get in touch to hear when something opens.'
              : 'Places that come up for rent show on this page with photos, the rent and a button to apply. Check back later.'}
          </p>
          {hasContact ? <div className="mt-1 flex flex-wrap justify-center gap-2">{contact}</div> : null}
        </div>
      ) : (
        <div className={`grid grid-cols-1 gap-6 md:grid-cols-2 ${items.length > 2 ? 'xl:grid-cols-3' : ''}`}>
          {items.map((unit) => (
            <Card key={unit.id} className="flex flex-col overflow-hidden">
              <Photos photos={unit.photos} label={unit.label} />
              <CardBody className="flex flex-1 flex-col gap-4 p-5">
                <div>
                  <p className="text-figure text-ink">
                    <Money whole cents={unit.monthlyRentCents} />
                    <span className="ml-1.5 text-meta font-normal text-ink-muted">a month</span>
                  </p>
                  <h2 className="mt-1 text-lead font-bold text-ink">{unit.label}</h2>
                  <p className="text-meta text-ink-muted">{unit.suburb}, {unit.city}</p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge tone="success">
                    {!unit.availableFrom || unit.availableFrom <= today ? 'Available now' : `From ${formatDate(unit.availableFrom)}`}
                  </Badge>
                  <Badge tone="neutral">{unit.bedrooms === 0 ? 'Studio' : `${unit.bedrooms} bedroom${unit.bedrooms === 1 ? '' : 's'}`}</Badge>
                  <Badge tone="neutral">{unit.bathrooms} bathroom{unit.bathrooms === 1 ? '' : 's'}</Badge>
                  {unit.parkingBays > 0 ? <Badge tone="neutral">{unit.parkingBays} parking bay{unit.parkingBays === 1 ? '' : 's'}</Badge> : null}
                  {unit.furnished ? <Badge tone="neutral">Furnished</Badge> : null}
                  {unit.petsAllowed ? <Badge tone="neutral">Pets allowed</Badge> : null}
                </div>
                {unit.description ? (
                  <p className="whitespace-pre-line text-body leading-relaxed text-ink">{unit.description}</p>
                ) : null}
                <div className="mt-auto space-y-3">
                  <p className="text-meta text-ink-muted">Deposit {rand(unit.depositCents)}</p>
                  <Link
                    to={`/apply?landlord=${encodeURIComponent(landlord.slug)}&unit=${unit.id}`}
                    className={`${listsButtonClass('primary', 'md')} w-full`}
                  >
                    Apply for {unit.label}
                  </Link>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <footer className="mt-12 flex flex-col items-center gap-2 border-t border-line pt-6 text-meta text-ink-muted">
        <span className="flex items-center gap-1.5">Listed with <Wordmark small /></span>
        <Link to="/privacy" className="inline-flex min-h-6 items-center underline">How applications handle your information</Link>
      </footer>
    </main>
  );
}
