import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, CardBody, Checkbox, Spinner, useToast } from '@hlonie/toolbox/ui';
import { api, humanError } from '../api/client';
import { PRIVACY_VERSION } from '../lib/privacy';
import { TERMS_VERSION } from '../lib/terms';
import { formatDate } from '../lib/format';
import { currentUser, endSession } from '../lib/session';
import { Wordmark } from './wordmark';
import { LinkButton } from './link-button';

interface PrivacyState {
  currentVersion: string;
  acceptedVersion: string | null;
  /** Landlord accounts only: the terms of service they run their business on. */
  terms: { currentVersion: string; acceptedVersion: string | null } | null;
}

/**
 * Nobody uses the app without having agreed to the current privacy notice. That covers accounts
 * made before consent was recorded, landlords provisioned by hand, and everyone once the notice
 * changes. Landlords also agree to the current terms of service. A failed check never locks
 * anyone out: the screens load and the check retries.
 */
export function ConsentGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['privacy'],
    queryFn: () => api.get<PrivacyState>('/me/privacy'),
    staleTime: 5 * 60_000,
  });

  if (isLoading) {
    return (
      <main className="flex min-h-dvh items-center justify-center">
        <Spinner />
      </main>
    );
  }
  if (!data) return <>{children}</>;
  const needsPrivacy = data.acceptedVersion !== PRIVACY_VERSION;
  const needsTerms = Boolean(data.terms) && data.terms!.acceptedVersion !== TERMS_VERSION;
  if (!needsPrivacy && !needsTerms) return <>{children}</>;

  const accept = async () => {
    setBusy(true);
    try {
      if (needsPrivacy) await api.post('/me/consents', { version: PRIVACY_VERSION });
      if (needsTerms) await api.post('/me/consents', { version: TERMS_VERSION, kind: 'terms_of_service' });
      await queryClient.invalidateQueries({ queryKey: ['privacy'] });
    } catch (error) {
      toast.show({ title: 'Not saved', description: humanError(error), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const changed = needsPrivacy ? Boolean(data.acceptedVersion) : Boolean(data.terms?.acceptedVersion);
  const what = needsPrivacy && needsTerms ? 'terms of service and privacy notice' : needsTerms ? 'terms of service' : 'privacy notice';
  const title = changed ? `Our ${what} ${needsPrivacy && needsTerms ? 'have' : 'has'} changed` : 'Before you carry on';

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center px-4 py-10">
      <span className="mb-6 block">
        <Wordmark />
      </span>
      <Card>
        <CardBody className="space-y-4 sm:px-7 sm:py-6">
          <h1 className="font-display text-display font-bold leading-tight tracking-[-0.01em] text-ink">{title}</h1>
          {needsTerms ? (
            <p className="text-body text-ink-muted">
              The terms of service of {formatDate(TERMS_VERSION)} set out what Threshold does for your business, what
              it costs, and who is responsible for your tenants' information.
            </p>
          ) : null}
          {needsPrivacy ? (
            <p className="text-body text-ink-muted">
              The privacy notice of {formatDate(PRIVACY_VERSION)} explains what this app holds about you, why,
              for how long, and how to see or erase it.
            </p>
          ) : null}
          <p className="text-body text-ink-muted">Read {needsPrivacy && needsTerms ? 'them' : 'it'}, then agree to continue.</p>
          {needsTerms ? (
            <LinkButton to="/terms" target="_blank" variant="secondary" block>
              Read the terms of service
            </LinkButton>
          ) : null}
          {needsPrivacy ? (
            <LinkButton to="/privacy" target="_blank" variant="secondary" block>
              Read the privacy notice
            </LinkButton>
          ) : null}
          <Checkbox
            id="privacy-consent"
            checked={ticked}
            onChange={(event) => setTicked(event.target.checked)}
            label={`I have read the ${what} and agree to ${needsPrivacy && needsTerms ? 'them' : 'it'}`}
          />
          <Button block size="lg" loading={busy} disabled={!ticked} onClick={accept}>
            Continue
          </Button>
        </CardBody>
      </Card>
      {/* Not agreeing has to be possible too: without this the only way out was to clear the browser. */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 truncate text-meta text-ink-muted">
          {currentUser()?.email ? `Signed in as ${currentUser()!.email}` : 'Not ready to agree?'}
        </p>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => endSession()}>
          Sign out
        </Button>
      </div>
    </main>
  );
}
