import { useState } from 'react';
import { useNavigate, Link } from 'react-router';
import { Button, Card, CardBody, Input, useToast } from '@hlonie/toolbox/ui';
import { api, humanError } from '../api/client';
import { startSession, type SessionUser } from '../lib/session';

/** Tenants self-serve because an applicant needs an identity before applying. Landlords are
    provisioned, the same split a Cognito user pool would enforce. */
export function Register() {
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();

  const create = async () => {
    setBusy(true);
    try {
      const result = await api.post<{ token: string; user: SessionUser }>('/auth/register', form);
      await startSession(result.token, result.user);
      navigate('/apply', { replace: true });
    } catch (error) {
      toast.show({ title: 'Account not created', description: humanError(error), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const missing = [
    form.name.trim().length < 2 ? 'your full name' : null,
    !form.email.includes('@') ? 'a valid email' : null,
    form.password.length < 8 ? 'a password of at least 8 characters' : null,
  ].filter(Boolean);
  const ready = missing.length === 0;

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4 py-10">
      <h1 className="mb-1 text-[26px] font-extrabold tracking-tight">Create an account</h1>
      <p className="mb-5 text-[14px] text-ink-muted">
        One account carries your application through to the lease, the deposit and beyond.
      </p>
      <Card>
        <CardBody className="space-y-3">
          <Input
            placeholder="Full name"
            name="name"
            autoComplete="name"
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
          <Input
            type="email"
            placeholder="Email"
            name="email"
            autoComplete="email"
            value={form.email}
            onChange={(event) => setForm({ ...form, email: event.target.value })}
          />
          <Input
            type="password"
            placeholder="Password, at least 8 characters"
            name="new-password"
            autoComplete="new-password"
            value={form.password}
            onChange={(event) => setForm({ ...form, password: event.target.value })}
          />
          <Button block loading={busy} disabled={!ready} onClick={create}>
            Create the account
          </Button>
          {!ready ? (
            <p className="text-center text-xs text-ink-muted">Still needed: {missing.join(', ')}.</p>
          ) : null}
          <p className="text-center text-[13px] text-ink-muted">
            Already have one?{' '}
            <Link to="/login" className="font-bold text-brand-500">Sign in</Link>
          </p>
        </CardBody>
      </Card>
    </main>
  );
}
