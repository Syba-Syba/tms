import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Alert, Button, Card, CardBody, Input, useToast } from '@hlonie/toolbox/ui';
import { api, humanError } from '../api/client';
import { startSession, type SessionUser } from '../lib/session';

/** Opened from the emailed link. A successful reset signs the person in and ends every other session. */
export function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();

  const mismatch = confirm.length > 0 && confirm !== password;
  const ready = password.length >= 8 && password === confirm;

  const save = async () => {
    setBusy(true);
    try {
      const result = await api.post<{ token: string; user: SessionUser }>('/auth/reset/confirm', {
        token,
        newPassword: password,
      });
      await startSession(result.token, result.user);
      toast.show({ title: 'Password changed', description: 'You are signed in.', tone: 'success' });
      navigate('/', { replace: true });
    } catch (error) {
      toast.show({ title: 'Password not changed', description: humanError(error), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4 py-10">
        <Alert tone="danger" title="This link is incomplete">
          Open the link from the email again, or{' '}
          <Link to="/forgot-password" className="font-bold">ask for a new one</Link>.
        </Alert>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4 py-10">
      <h1 className="mb-1 font-display text-[30px] font-medium leading-tight tracking-[-0.01em]">Choose a new password</h1>
      <p className="mb-5 text-[14px] text-ink-muted">
        This signs you out on every other device.
      </p>
      <Card>
        <CardBody className="space-y-3">
          <Input
            type="password"
            placeholder="New password, at least 8 characters"
            name="new-password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <Input
            type="password"
            placeholder="Type it again"
            name="confirm-password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && ready && save()}
          />
          {mismatch ? <p className="text-xs text-danger">The two passwords differ.</p> : null}
          <Button block loading={busy} disabled={!ready} onClick={save}>
            Save and sign in
          </Button>
          <p className="text-center text-[13px] text-ink-muted">
            Link expired? <Link to="/forgot-password" className="font-bold text-brand-500">Ask for a new one</Link>
          </p>
        </CardBody>
      </Card>
    </main>
  );
}
