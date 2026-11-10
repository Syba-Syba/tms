import { useState } from 'react';
import { Link } from 'react-router';
import { Alert, Button, Input, useToast } from '@hlonie/toolbox/ui';
import { Field } from '@hlonie/toolbox/forms';
import { api, humanError } from '../api/client';
import { AuthHeading, AuthLayout } from '../components/auth-layout';
import { TEXT_LINK } from '../components/link-button';

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
    <AuthLayout>
      <AuthHeading title="Forgot your password?">
        Enter the email you signed up with. We send a link to choose a new password.
      </AuthHeading>
      {sent ? (
        <Alert tone="success" title="Check your email" className="mb-4">
          {sent}
        </Alert>
      ) : null}
      <div className="space-y-4">
          <Field label="Email" htmlFor="forgot-email">
          <Input
            id="forgot-email"
            type="email"
            name="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && email.includes('@') && send()}
          />
          </Field>
          <Button block size="lg" loading={busy} disabled={!email.includes('@')} onClick={send}>
            {sent ? 'Send another link' : 'Send reset link'}
          </Button>
          <p className="text-center text-meta text-ink-muted">
            Remembered it? <Link to="/login" className={TEXT_LINK}>Sign in</Link>
          </p>
      </div>
    </AuthLayout>
  );
}
