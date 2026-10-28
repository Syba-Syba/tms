import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Button, Card, CardBody, Checkbox, Spinner, useToast } from '@hlonie/toolbox/ui';
import { api, humanError } from '../api/client';
import { PRIVACY_VERSION } from '../lib/privacy';
import { formatDate } from '../lib/format';

interface PrivacyState {
  currentVersion: string;
  acceptedVersion: string | null;
}

/**
 * Nobody uses the app without having agreed to the current privacy notice. That covers accounts
 * made before consent was recorded, landlords provisioned by hand, and everyone once the notice
 * changes. A failed check never locks anyone out: the screens load and the check retries.
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
  if (!data || data.acceptedVersion === PRIVACY_VERSION) return <>{children}</>;

  const accept = async () => {
    setBusy(true);
    try {
      await api.post('/me/consents', { version: PRIVACY_VERSION });
      await queryClient.invalidateQueries({ queryKey: ['privacy'] });
    } catch (error) {
      toast.show({ title: 'Not saved', description: humanError(error), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-10">
      <Card>
        <CardBody className="space-y-4">
          <h1 className="font-display text-[30px] font-medium leading-tight tracking-[-0.01em]">
            {data.acceptedVersion ? 'Our privacy notice has changed' : 'Before you carry on'}
          </h1>
          <p className="text-[14px] text-ink-muted">
            The privacy notice of {formatDate(PRIVACY_VERSION)} explains what this app holds about you, why,
            for how long, and how to see or erase it. Read it, then agree to continue.
          </p>
          <Link to="/privacy" target="_blank" className="block text-[14px] font-bold text-brand-500">
            Read the privacy notice
          </Link>
          <Checkbox
            id="privacy-consent"
            checked={ticked}
            onChange={(event) => setTicked(event.target.checked)}
            label="I have read the privacy notice and agree to it"
          />
          <Button block loading={busy} disabled={!ticked} onClick={accept}>
            Continue
          </Button>
        </CardBody>
      </Card>
    </main>
  );
}
