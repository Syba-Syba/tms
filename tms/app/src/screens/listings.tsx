import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { Badge, Card, CardBody, EmptyState, Spinner } from '@hlonie/toolbox/ui';
import { formatZar } from '@hlonie/toolbox/utils';
import { api, errorCode } from '../api/client';
import { formatDate } from '../lib/format';
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
    return (
      <div className="flex h-20 items-center justify-center bg-surface-muted text-[13px] text-ink-muted">
        No photos yet
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
        <span className="absolute bottom-2 right-2 rounded-sm bg-black/65 px-2 py-0.5 text-[12px] font-semibold text-white">
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

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <p className="label mb-1">To let</p>
        <h1 className="font-display text-[32px] font-medium leading-tight tracking-[-0.01em]">{landlord.name}</h1>
        <p className="mt-1 text-[14px] text-ink-muted">
          {items.length === 0 ? 'Nothing vacant right now.' : `${items.length} place${items.length === 1 ? '' : 's'} available.`}{' '}
          Questions? <a href={`tel:${landlord.phone.replace(/\s/g, '')}`} className="font-bold text-brand-500">{landlord.phone}</a>
          {' or '}
          <a href={`mailto:${landlord.email}`} className="font-bold text-brand-500">{landlord.email}</a>
        </p>
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
                    <h2 className="text-[17px] font-semibold">{unit.label}</h2>
                    <p className="text-[13px] text-ink-muted">{unit.suburb}, {unit.city}</p>
                  </div>
                  <p className="font-display text-[24px] font-medium tabular-nums">
                    {rand(unit.monthlyRentCents)}
                    <span className="ml-1 text-[13px] font-normal text-ink-muted">a month</span>
                  </p>
                </div>
                <p className="text-[13.5px] text-ink">
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
                  <p className="whitespace-pre-line text-[14px] leading-relaxed text-ink">{unit.description}</p>
                ) : null}
                <p className="text-[13px] text-ink-muted">Deposit {rand(unit.depositCents)}</p>
                <Link
                  to={`/apply?landlord=${encodeURIComponent(landlord.slug)}&unit=${unit.id}`}
                  className="flex h-10 w-full items-center justify-center rounded-sm bg-ink text-[14px] font-semibold text-white hover:bg-ink/90"
                >
                  Apply for {unit.label}
                </Link>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <footer className="mt-10 text-center text-[12px] text-ink-muted">
        Applications are handled with Threshold.{' '}
        <Link to="/privacy" className="underline">Privacy notice</Link>
      </footer>
    </main>
  );
}
