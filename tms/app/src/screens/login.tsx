import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate, Link } from 'react-router';
import { Alert, Button, Input, useToast } from '@hlonie/toolbox/ui';
import { Field } from '@hlonie/toolbox/forms';
import { api, baseUrl, errorCode, humanError } from '../api/client';
import { safeReturnPath } from '../lib/safe-path';
import { startSession, type SessionUser } from '../lib/session';
import { AuthHeading, AuthLayout } from '../components/auth-layout';
import { LinkButton, TEXT_LINK } from '../components/link-button';

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // Asked for once the password is right and two-step sign-in is on.
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [apiDown, setApiDown] = useState(false);
  // Said under the fields, so the button never has to look switched off while it works.
  const [problem, setProblem] = useState<string | null>(null);

  // A wrong VITE_API_URL or a dead server should be named on screen, not guessed at.
  // '/health' is public on every deployment ('/' 404s behind API Gateway). Any HTTP answer,
  // even a 503 from a degraded health check, proves the API is reachable; only a network
  // failure means it is not.
  useEffect(() => {
    fetch(`${baseUrl.replace(/\/$/, '')}/health`, { method: 'GET' })
      .then(() => setApiDown(false))
      .catch(() => setApiDown(true));
  }, []);
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const location = useLocation();
  // Someone who followed a landlord's listings link and has no account yet keeps the link
  // through sign-up, so they land on that landlord's units afterwards.
  // The guard passes the target in router state; an expired session signs out with a full
  // page load (api/client.ts), which cannot carry state, so it arrives as ?from= instead.
  // Both come from the address bar, so both go through safeReturnPath.
  const queryFrom = new URLSearchParams(location.search).get('from');
  const returnTo =
    (location.state as { from?: string } | null)?.from ?? (queryFrom ? safeReturnPath(queryFrom, '') : '');
  const returnParams = new URLSearchParams(returnTo.startsWith('/apply') ? returnTo.split('?')[1] ?? '' : '');
  const listing = returnParams.get('landlord');
  const listedUnit = returnParams.get('unit');
  const registerLink = listing
    ? `/register?landlord=${encodeURIComponent(listing)}${listedUnit ? `&unit=${encodeURIComponent(listedUnit)}` : ''}`
    : '/register';

  // A ref, not the busy state: a held Enter key repeats before React re-renders, and each
  // extra /auth/login counted towards the lockout.
  const inFlight = useRef(false);
  const signIn = async () => {
    if (inFlight.current) return;
    if (!email || !password) {
      setProblem('Enter your email and your password.');
      return;
    }
    if (code !== null && code.trim().length < 6) {
      setProblem('Enter the 6 digits from your authenticator app, or a recovery code.');
      return;
    }
    setProblem(null);
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await api.post<{ token: string; user: SessionUser }>('/auth/login', {
        email,
        password,
        ...(code ? { code } : {}),
      });
      await startSession(result.token, result.user);
      // A new identity: nothing cached for whoever was signed in before may be shown to this one.
      queryClient.clear();
      // Back to wherever the guard caught them, e.g. a copied /apply?unit= link. The target
      // came out of the address bar, so anything leaving this origin falls back to home.
      navigate(safeReturnPath(returnTo), {
        replace: true,
      });
    } catch (error) {
      const reason = errorCode(error);
      if (reason === 'code_required') {
        setCode('');
        return;
      }
      if (reason === 'code_wrong') {
        toast.show({ title: 'That code did not match', description: 'Use the newest code in the app, or a recovery code.', tone: 'danger' });
        return;
      }
      const wrongCreds = (error as { status?: number }).status === 401;
      toast.show({
        title: 'Sign in failed',
        description: wrongCreds ? 'That email and password do not match.' : humanError(error),
        tone: 'danger',
      });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      <AuthHeading title="Sign in">
        For landlords and tenants: rent, repairs and the lease in one place.
      </AuthHeading>
      {apiDown ? (
        import.meta.env.DEV ? (
          <Alert tone="danger" title="The API is not answering" className="mb-4">
            Nothing is listening at {baseUrl}. Run `npm run dev` and check the api lines, then
            reload this page.
          </Alert>
        ) : (
          <Alert tone="danger" title="Can't reach the server" className="mb-4">
            Check your connection, then reload this page.
          </Alert>
        )
      ) : null}
      {/* A form, so Enter signs in and a password manager's filled-in values are submitted. */}
      <form
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void signIn();
        }}
      >
        <Field label="Email" htmlFor="login-email">
          <Input
            id="login-email"
            type="email"
            name="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <Field label="Password" htmlFor="login-password">
          <Input
            id="login-password"
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              // Handled here rather than by the form's own submit, so a held key is one sign-in.
              event.preventDefault();
              void signIn();
            }}
          />
        </Field>
        {code !== null ? (
          <div className="space-y-1.5">
            <label htmlFor="login-code" className="block text-body font-medium text-ink">Code from your authenticator app</label>
            <Input
              id="login-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              placeholder="123 456"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                void signIn();
              }}
            />
            <p className="text-xs text-ink-muted">Lost your phone? Type one of your recovery codes instead.</p>
          </div>
        ) : null}
        {problem ? <p role="alert" className="text-meta font-semibold text-danger">{problem}</p> : null}
        <Button block size="lg" type="submit" loading={busy}>
          {code !== null ? 'Continue' : 'Sign in'}
        </Button>
        <p className="text-center text-meta">
          <Link to="/forgot-password" className={`inline-flex min-h-6 items-center ${TEXT_LINK}`}>Forgot your password?</Link>
        </p>
      </form>

      <section className="mt-8 border-t border-line pt-6" aria-labelledby="login-new">
        <h2 id="login-new" className="text-lead font-bold text-ink">New to Threshold?</h2>
        <p className="mb-3 mt-1 text-meta text-ink-muted">Create an account. It takes a minute.</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <LinkButton to={registerLink}>I am applying for a place</LinkButton>
          <LinkButton to="/register?as=landlord">I am a landlord</LinkButton>
        </div>
      </section>

      <p className="mt-6 text-center text-xs">
        <Link to="/privacy" className="inline-flex min-h-6 items-center text-ink-muted underline">Privacy notice</Link>
        {' · '}
        <Link to="/terms" className="inline-flex min-h-6 items-center text-ink-muted underline">Terms of service</Link>
      </p>
      {import.meta.env.DEV ? (
        <Alert tone="info" title="Development sign-ins" className="mt-4">
          landlord@example.co.za, kgee@example.co.za, naledi@example.co.za, lerato@example.co.za or sipho@example.co.za. Password: dev
        </Alert>
      ) : null}
    </AuthLayout>
  );
}
