import { useState } from 'react';
import { Button, Card, CardBody, Input, useToast } from '@hlonie/toolbox/ui';
import { api, humanError } from '../api/client';
import { startSession, type SessionUser } from '../lib/session';

type Field = 'currentPassword' | 'newPassword' | 'confirm';

/**
 * There was no way to change a password, so one that had been shared or seen could only be
 * replaced by deleting the database. Changing it here signs out every other device: the API
 * hands back a fresh token for this one and refuses the old ones.
 */
export function ChangePassword() {
  const toast = useToast();
  const [values, setValues] = useState<Record<Field, string>>({
    currentPassword: '',
    newPassword: '',
    confirm: '',
  });
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [busy, setBusy] = useState(false);

  const set = (field: Field) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setValues((current) => ({ ...current, [field]: event.target.value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const mismatch = values.confirm.length > 0 && values.confirm !== values.newPassword;
  const ready =
    values.currentPassword.length > 0 && values.newPassword.length >= 8 && values.confirm === values.newPassword;

  const submit = async () => {
    setBusy(true);
    try {
      const result = await api.post<{ token: string; user: SessionUser }>('/auth/password', {
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });
      await startSession(result.token, result.user);
      setValues({ currentPassword: '', newPassword: '', confirm: '' });
      toast.show({
        title: 'Password changed',
        description: 'Every other device has been signed out.',
        tone: 'success',
      });
    } catch (error) {
      // The API names the field at fault; put the message under that field, not in a toast.
      const details = (error as { body?: { error?: { details?: Partial<Record<Field, string>> } } })
        ?.body?.error?.details;
      if (details && Object.keys(details).length > 0) setErrors(details);
      else toast.show({ title: 'Password not changed', description: humanError(error), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardBody className="space-y-3">
        <div>
          <p className="text-lead font-semibold">Password</p>
          <p className="text-xs text-ink-muted">Changing it signs you out everywhere else.</p>
        </div>
        <FieldInput
          label="Current password"
          autoComplete="current-password"
          value={values.currentPassword}
          onChange={set('currentPassword')}
          error={errors.currentPassword}
        />
        <FieldInput
          label="New password"
          autoComplete="new-password"
          value={values.newPassword}
          onChange={set('newPassword')}
          error={
            errors.newPassword ??
            (values.newPassword.length > 0 && values.newPassword.length < 8 ? 'Use at least 8 characters.' : undefined)
          }
        />
        <FieldInput
          label="Confirm new password"
          autoComplete="new-password"
          value={values.confirm}
          onChange={set('confirm')}
          error={mismatch ? 'These do not match.' : undefined}
          onEnter={() => ready && !busy && submit()}
        />
        <Button loading={busy} disabled={!ready} onClick={submit}>
          Change password
        </Button>
      </CardBody>
    </Card>
  );
}

function FieldInput(props: {
  label: string;
  autoComplete: string;
  value: string;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  error?: string;
  onEnter?: () => void;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-meta font-medium">{props.label}</span>
      <Input
        type="password"
        autoComplete={props.autoComplete}
        value={props.value}
        onChange={props.onChange}
        aria-invalid={props.error ? true : undefined}
        onKeyDown={(event) => event.key === 'Enter' && props.onEnter?.()}
      />
      {props.error ? <span className="block text-xs text-danger">{props.error}</span> : null}
    </label>
  );
}
