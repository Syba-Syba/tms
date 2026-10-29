import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { encode } from 'uqr';
import { Alert, Badge, Button, Card, CardBody, Input, Modal, useToast } from '@hlonie/toolbox/ui';
import { api, humanError } from '../api/client';

interface Status { enabled: boolean; recoveryCodesLeft: number }

/** The otpauth link as a QR code, drawn as SVG squares so no markup is injected. */
function QrCode({ value }: { value: string }) {
  const { data, size } = useMemo(() => encode(value, { border: 2 }), [value]);
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="h-48 w-48 rounded-sm bg-white" role="img" aria-label="QR code to scan">
      {data.flatMap((row, y) =>
        row.map((dark, x) => (dark ? <rect key={`${x}-${y}`} x={x} y={y} width={1.02} height={1.02} fill="#111" /> : null)),
      )}
    </svg>
  );
}

export const useTwoStep = () =>
  useQuery({ queryKey: ['two-step'], queryFn: () => api.get<Status>('/auth/two-step'), retry: false });

/**
 * Two-step sign-in: after the password, a code from an authenticator app. Owners need it to
 * change the bank account, and anyone can turn it on.
 */
export function TwoStep() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data } = useTwoStep();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  if (!data) return null;

  const act = async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    try {
      return await fn();
    } catch (error) {
      toast.show({ title: 'That did not work', description: humanError(error), tone: 'danger' });
      return null;
    } finally {
      setBusy(false);
    }
  };

  const start = () =>
    act(async () => {
      setSetup(await api.post<{ secret: string; otpauthUrl: string }>('/auth/two-step', { action: 'setup' }));
      setCode('');
    });

  const enable = () =>
    act(async () => {
      const result = await api.post<{ recoveryCodes: string[] }>('/auth/two-step', { action: 'enable', code });
      setSetup(null);
      setRecovery(result.recoveryCodes);
      await queryClient.invalidateQueries({ queryKey: ['two-step'] });
    });

  const disable = () =>
    act(async () => {
      await api.post('/auth/two-step', { action: 'disable', password, code });
      setDisabling(false);
      setPassword('');
      setCode('');
      toast.show({ title: 'Two-step sign-in is off', tone: 'success' });
      await queryClient.invalidateQueries({ queryKey: ['two-step'] });
    });

  const saveCodes = () => {
    if (!recovery) return;
    const url = URL.createObjectURL(new Blob([`Threshold recovery codes. Each works once.\n\n${recovery.join('\n')}\n`], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'threshold-recovery-codes.txt';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section aria-label="Two-step sign-in">
      <h2 className="label mb-2">Two-step sign-in</h2>
      <Card>
        <CardBody className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <p className="text-meta text-ink">
              After your password, a six-digit code from an app on your phone: Google Authenticator, Microsoft
              Authenticator or similar. Someone who learns your password still cannot sign in.
            </p>
            <Badge tone={data.enabled ? 'success' : 'neutral'}>{data.enabled ? 'On' : 'Off'}</Badge>
          </div>
          {data.enabled ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-xs text-ink-muted">{data.recoveryCodesLeft} recovery codes left.</p>
              <Button size="sm" variant="outline" onClick={() => { setDisabling(true); setCode(''); }}>Turn off</Button>
            </div>
          ) : (
            <Button size="sm" loading={busy} onClick={start}>Turn on</Button>
          )}
        </CardBody>
      </Card>

      <Modal open={setup !== null} onOpenChange={(open) => { if (!open) setSetup(null); }} title="Turn on two-step sign-in"
        description="Scan this with your authenticator app, then type the code it shows.">
        {setup ? (
          <div className="space-y-3">
            <div className="flex justify-center"><QrCode value={setup.otpauthUrl} /></div>
            <p className="text-center text-xs text-ink-muted">
              Cannot scan? Enter this key in the app instead:
              <span className="mt-1 block break-all font-mono text-meta text-ink">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</span>
            </p>
            <Input aria-label="Code from the app" inputMode="numeric" autoComplete="one-time-code" placeholder="123 456"
              value={code} onChange={(event) => setCode(event.target.value)} />
            <Button block loading={busy} disabled={code.replace(/\s/g, '').length !== 6} onClick={enable}>Turn on</Button>
          </div>
        ) : null}
      </Modal>

      <Modal open={recovery !== null} onOpenChange={(open) => { if (!open) setRecovery(null); }} title="Keep these recovery codes"
        description="If you lose your phone, each one signs you in once. They are shown only now.">
        {recovery ? (
          <div className="space-y-3">
            <ol className="grid grid-cols-2 gap-2 rounded-sm border border-line bg-surface-muted p-3 font-mono text-body">
              {recovery.map((item) => <li key={item}>{item}</li>)}
            </ol>
            <Alert tone="warning" title="Store them away from your phone">
              In a password manager, or printed and filed with your property papers.
            </Alert>
            <div className="flex gap-2">
              <Button variant="outline" onClick={saveCodes}>Download</Button>
              <Button onClick={() => setRecovery(null)}>I have saved them</Button>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal open={disabling} onOpenChange={setDisabling} title="Turn off two-step sign-in"
        description="Your password alone will sign you in again. Owners cannot change the bank account while it is off.">
        <div className="space-y-3">
          <Input type="password" aria-label="Your password" placeholder="Your password" autoComplete="current-password"
            value={password} onChange={(event) => setPassword(event.target.value)} />
          <Input aria-label="Code from the app" inputMode="numeric" autoComplete="one-time-code" placeholder="Code from the app"
            value={code} onChange={(event) => setCode(event.target.value)} />
          <Button block variant="danger" loading={busy} disabled={!password || code.trim().length < 6} onClick={disable}>Turn off</Button>
        </div>
      </Modal>
    </section>
  );
}
