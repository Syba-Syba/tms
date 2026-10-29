import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Button, Card, CardBody, Checkbox, Spinner, useToast } from '@hlonie/toolbox/ui';
import { api, humanError } from '../api/client';
import { PRIVACY_VERSION } from '../lib/privacy';
import { TERMS_VERSION } from '../lib/terms';
import { formatDate } from '../lib/format';

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
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-10">
      <Card>
        <CardBody className="space-y-4">
          <h1 className="font-display text-display font-medium leading-tight tracking-[-0.01em]">{title}</h1>
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
            <Link to="/terms" target="_blank" className="block text-body font-bold text-brand-500">
              Read the terms of service
            </Link>
          ) : null}
          {needsPrivacy ? (
            <Link to="/privacy" target="_blank" className="block text-body font-bold text-brand-500">
              Read the privacy notice
            </Link>
          ) : null}
          <Checkbox
            id="privacy-consent"
            checked={ticked}
            onChange={(event) => setTicked(event.target.checked)}
            label={`I have read the ${what} and agree to ${needsPrivacy && needsTerms ? 'them' : 'it'}`}
          />
          <Button block loading={busy} disabled={!ticked} onClick={accept}>
            Continue
          </Button>
        </CardBody>
      </Card>
    </main>
  );
}
