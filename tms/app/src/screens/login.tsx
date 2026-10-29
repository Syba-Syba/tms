import { useEffect, useState } from 'react';
import { useLocation, useNavigate, Link } from 'react-router';
import { Alert, Button, Card, CardBody, Input, useToast } from '@hlonie/toolbox/ui';
import { api, baseUrl, errorCode, humanError } from '../api/client';
import { safeReturnPath } from '../lib/safe-path';
import { startSession, type SessionUser } from '../lib/session';
import { Wordmark } from '../components/wordmark';

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // Asked for once the password is right and two-step sign-in is on.
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [apiDown, setApiDown] = useState(false);

  // A wrong VITE_API_URL or a dead server should be named on screen, not guessed at.
  useEffect(() => {
    fetch(baseUrl + '/', { method: 'GET' })
      .then((response) => setApiDown(!response.ok))
      .catch(() => setApiDown(true));
  }, []);
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  // Someone who followed a landlord's listings link and has no account yet keeps the link
  // through sign-up, so they land on that landlord's units afterwards.
  const returnTo = (location.state as { from?: string } | null)?.from ?? '';
  const returnParams = new URLSearchParams(returnTo.startsWith('/apply') ? returnTo.split('?')[1] ?? '' : '');
  const listing = returnParams.get('landlord');
  const listedUnit = returnParams.get('unit');
  const registerLink = listing
    ? `/register?landlord=${encodeURIComponent(listing)}${listedUnit ? `&unit=${encodeURIComponent(listedUnit)}` : ''}`
    : '/register';

  const signIn = async () => {
    setBusy(true);
    try {
      const result = await api.post<{ token: string; user: SessionUser }>('/auth/login', {
        email,
        password,
        ...(code ? { code } : {}),
      });
      await startSession(result.token, result.user);
      // Back to wherever the guard caught them, e.g. a copied /apply?unit= link. The target
      // came out of the address bar, so anything leaving this origin falls back to home.
      navigate(safeReturnPath((location.state as { from?: string } | null)?.from), {
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
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4 py-10">
      <span className="mb-8" aria-hidden>
        <Wordmark />
      </span>
      <h1 className="mb-1 font-display text-display font-medium leading-tight tracking-[-0.01em]">Sign in</h1>
      <p className="mb-5 text-body text-ink-muted">
        Your lease, rent, inspections and maintenance, in one place.
      </p>
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
      <Card>
        <CardBody className="space-y-3">
          <Input
            type="email"
            placeholder="Email"
            name="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <Input
            type="password"
            placeholder="Password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && email && password && signIn()}
          />
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
                onKeyDown={(event) => event.key === 'Enter' && code.trim().length >= 6 && signIn()}
              />
              <p className="text-xs text-ink-muted">Lost your phone? Type one of your recovery codes instead.</p>
            </div>
          ) : null}
          <Button block loading={busy} disabled={!email || !password || (code !== null && code.trim().length < 6)} onClick={signIn}>
            {code !== null ? 'Continue' : 'Sign in'}
          </Button>
          <p className="text-center text-meta">
            <Link to="/forgot-password" className="inline-flex min-h-6 items-center font-bold text-brand-500">Forgot your password?</Link>
          </p>
          <p className="text-center text-meta text-ink-muted">
            Applying for a place?{' '}
            <Link to={registerLink} className="inline-flex min-h-6 items-center font-bold text-brand-500">Create an account</Link>
          </p>
          <p className="text-center text-xs">
            <Link to="/privacy" className="inline-flex min-h-6 items-center text-ink-muted underline">Privacy notice</Link>
            {' · '}
            <Link to="/terms" className="inline-flex min-h-6 items-center text-ink-muted underline">Terms of service</Link>
          </p>
        </CardBody>
      </Card>
      {import.meta.env.DEV ? (
        <Alert tone="info" title="Development sign-ins" className="mt-4">
          landlord@example.co.za, kgee@example.co.za, naledi@example.co.za, lerato@example.co.za or sipho@example.co.za. Password: dev
        </Alert>
      ) : null}
    </main>
  );
}
