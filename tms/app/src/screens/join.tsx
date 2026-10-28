import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Alert, Button, Card, CardBody, Checkbox, Input, Spinner, useToast } from '@hlonie/toolbox/ui';
import { api, humanError } from '../api/client';
import { PRIVACY_VERSION } from '../lib/privacy';
import { startSession, type SessionUser } from '../lib/session';

/** Where an invited agent lands from the email: who asked them, then a password, then in. */
export function Join() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const invite = useQuery({
    queryKey: ['invite', token],
    queryFn: () =>
      api.post<{ kind: 'agent' | 'tenant'; name: string; email: string; landlord: string; unit?: string; hasAccount: boolean }>(
        '/invites/lookup',
        { token },
      ),
    enabled: token.length > 0,
    retry: false,
  });

  const join = async () => {
    setBusy(true);
    try {
      const result = await api.post<{ token: string; user: SessionUser }>('/invites/accept', {
        token, password, consentVersion: PRIVACY_VERSION,
      });
      await startSession(result.token, result.user);
      navigate('/', { replace: true });
    } catch (failure) {
      toast.show({ title: 'Could not join', description: humanError(failure), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4 py-10">
      {invite.isLoading ? (
        <Spinner />
      ) : !invite.data ? (
        <Alert tone="warning" title="This link no longer works">
          It may have expired, been used already, or been cancelled. Ask the person who added you to send a new one.{' '}
          <Link to="/login" className="font-bold text-brand-500">Sign in</Link>
        </Alert>
      ) : (
        <>
          <h1 className="mb-1 font-display text-[30px] font-medium leading-tight tracking-[-0.01em]">
            {invite.data.kind === 'tenant' ? `Your lease for ${invite.data.unit}` : `Join ${invite.data.landlord}`}
          </h1>
          <p className="mb-5 text-[14px] text-ink-muted">
            Hi {invite.data.name}.{' '}
            {invite.data.kind === 'tenant'
              ? `${invite.data.landlord} runs your lease on Threshold: your rent, your statement, proof of payment and repairs. `
              : 'Choose a password to help run their rentals. '}
            {invite.data.hasAccount
              ? `You already have an account as ${invite.data.email}. Enter its password to add this lease to it.`
              : `You sign in as ${invite.data.email}.`}
          </p>
          <Card>
            <CardBody className="space-y-3">
              <Input type="password" aria-label="Password"
                placeholder={invite.data.hasAccount ? 'Your password' : 'Password, at least 8 characters'}
                autoComplete={invite.data.hasAccount ? 'current-password' : 'new-password'}
                value={password} onChange={(event) => setPassword(event.target.value)} />
              <Checkbox
                id="join-consent"
                checked={consent}
                onChange={(event) => setConsent(event.target.checked)}
                label={
                  <span>
                    I have read the{' '}
                    <Link to="/privacy" target="_blank" className="font-bold text-brand-500">privacy notice</Link>{' '}
                    and agree to it
                  </span>
                }
              />
              <Button block loading={busy} disabled={password.length < (invite.data.hasAccount ? 1 : 8) || !consent} onClick={join}>
                {invite.data.kind === 'tenant' ? 'Open my lease' : 'Join'}
              </Button>
              {invite.data.hasAccount ? (
                <p className="text-center text-[13px] text-ink-muted">
                  Forgot it? <Link to="/forgot-password" className="font-bold text-brand-500">Reset your password</Link>, then open this link again.
                </p>
              ) : null}
            </CardBody>
          </Card>
        </>
      )}
    </main>
  );
}
