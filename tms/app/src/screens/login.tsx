import { useEffect, useState } from 'react';
import { useLocation, useNavigate, Link } from 'react-router';
import { Alert, Button, Card, CardBody, Input, useToast } from '@hlonie/toolbox/ui';
import { api, baseUrl, humanError } from '../api/client';
import { safeReturnPath } from '../lib/safe-path';
import { startSession, type SessionUser } from '../lib/session';

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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

  const signIn = async () => {
    setBusy(true);
    try {
      const result = await api.post<{ token: string; user: SessionUser }>('/auth/login', {
        email,
        password,
      });
      await startSession(result.token, result.user);
      // Back to wherever the guard caught them, e.g. a copied /apply?unit= link. The target
      // came out of the address bar, so anything leaving this origin falls back to home.
      navigate(safeReturnPath((location.state as { from?: string } | null)?.from), {
        replace: true,
      });
    } catch (error) {
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
      <h1 className="mb-1 text-[26px] font-extrabold tracking-tight">Sign in</h1>
      <p className="mb-5 text-[14px] text-ink-muted">
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
          <Button block loading={busy} disabled={!email || !password} onClick={signIn}>
            Sign in
          </Button>
          <p className="text-center text-[13px] text-ink-muted">
            Applying for a place?{' '}
            <Link to="/register" className="font-bold text-brand-500">Create an account</Link>
          </p>
        </CardBody>
      </Card>
      {import.meta.env.DEV ? (
        <Alert tone="info" title="Development sign-ins" className="mt-4">
          landlord@example.co.za, naledi@example.co.za or sipho@example.co.za — password: dev
        </Alert>
      ) : null}
    </main>
  );
}
