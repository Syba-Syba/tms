import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Alert, Button, Checkbox, Input, Spinner, useToast } from '@hlonie/toolbox/ui';
import { Field } from '@hlonie/toolbox/forms';
import { api, errorCode, humanError } from '../api/client';
import { AuthHeading, AuthLayout } from '../components/auth-layout';
import { TEXT_LINK } from '../components/link-button';
import { PRIVACY_VERSION } from '../lib/privacy';
import { startSession, type SessionUser } from '../lib/session';

/** Where an invited agent lands from the email: who asked them, then a password, then in. */
export function Join() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [consent, setConsent] = useState(false);
  const [code, setCode] = useState<string | null>(null);
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
        token, password, consentVersion: PRIVACY_VERSION, ...(code ? { code } : {}),
      });
      await startSession(result.token, result.user);
      // A new identity: nothing cached for whoever was signed in before may be shown to this one.
      queryClient.clear();
      navigate('/', { replace: true });
    } catch (failure) {
      if (errorCode(failure) === 'code_required') {
        setCode('');
        return;
      }
      toast.show({ title: 'Could not join', description: humanError(failure), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      {invite.isLoading ? (
        <Spinner />
      ) : !invite.data ? (
        <Alert tone="warning" title="This link no longer works">
          It may have expired, been used already, or been cancelled. Ask the person who added you to send a new one.{' '}
          <Link to="/login" className={TEXT_LINK}>Sign in</Link>
        </Alert>
      ) : (
        <>
          <AuthHeading title={invite.data.kind === 'tenant' ? `Your lease for ${invite.data.unit}` : `Join ${invite.data.landlord}`}>
            Hi {invite.data.name}.{' '}
            {invite.data.kind === 'tenant'
              ? `${invite.data.landlord} runs your lease on Threshold: your rent, your statement, proof of payment and repairs. `
              : 'Choose a password to help run their rentals. '}
            {invite.data.hasAccount
              ? `You already have an account as ${invite.data.email}. Enter its password to add this lease to it.`
              : `You sign in as ${invite.data.email}.`}
          </AuthHeading>
          <div className="space-y-4">
              <Field label={invite.data.hasAccount ? 'Your password' : 'Password'} htmlFor="join-password"
                hint={invite.data.hasAccount ? undefined : 'At least 8 characters.'}>
              <Input id="join-password" type="password"
                autoComplete={invite.data.hasAccount ? 'current-password' : 'new-password'}
                value={password} onChange={(event) => setPassword(event.target.value)} />
              </Field>
              {code !== null ? (
                <Field label="Code from your authenticator app" htmlFor="join-code">
                  <Input id="join-code" inputMode="numeric" autoComplete="one-time-code"
                    value={code} onChange={(event) => setCode(event.target.value)} />
                </Field>
              ) : null}
              <Checkbox
                id="join-consent"
                checked={consent}
                onChange={(event) => setConsent(event.target.checked)}
                label={
                  <span>
                    I have read the{' '}
                    <Link to="/privacy" target="_blank" className={TEXT_LINK}>privacy notice</Link>{' '}
                    and agree to it
                  </span>
                }
              />
              <Button block size="lg" loading={busy} disabled={password.length < (invite.data.hasAccount ? 1 : 8) || !consent} onClick={join}>
                {invite.data.kind === 'tenant' ? 'Open my lease' : 'Join'}
              </Button>
              {invite.data.hasAccount ? (
                <p className="text-center text-meta text-ink-muted">
                  Forgot it? <Link to="/forgot-password" className={TEXT_LINK}>Reset your password</Link>, then open this link again.
                </p>
              ) : null}
          </div>
        </>
      )}
    </AuthLayout>
  );
}
