import { useState } from 'react';
import { Link } from 'react-router';
import { Alert, Button, Card, CardBody, Input, useToast } from '@hlonie/toolbox/ui';
import { api, humanError } from '../api/client';

/** The server answers the same whether or not the email has an account, so this screen does too. */
export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const toast = useToast();

  const send = async () => {
    setBusy(true);
    try {
      const result = await api.post<{ message: string }>('/auth/reset/request', { email });
      setSent(result.message);
    } catch (error) {
      toast.show({ title: 'Reset not sent', description: humanError(error), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4 py-10">
      <h1 className="mb-1 font-display text-display font-medium leading-tight tracking-[-0.01em]">Forgot your password?</h1>
      <p className="mb-5 text-body text-ink-muted">
        Enter the email you signed up with. We send a link to choose a new password.
      </p>
      {sent ? (
        <Alert tone="success" title="Check your email" className="mb-4">
          {sent}
        </Alert>
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
            onKeyDown={(event) => event.key === 'Enter' && email.includes('@') && send()}
          />
          <Button block loading={busy} disabled={!email.includes('@')} onClick={send}>
            {sent ? 'Send another link' : 'Send reset link'}
          </Button>
          <p className="text-center text-meta text-ink-muted">
            Remembered it? <Link to="/login" className="font-bold text-brand-500">Sign in</Link>
          </p>
        </CardBody>
      </Card>
    </main>
  );
}
