import { useState, type ReactNode } from 'react';
import { Button } from './button';
import { Input } from './input';
import { Modal } from './modal';

/** Destructive actions require typing the reference, so muscle memory cannot delete a claim. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  requireText,
  onConfirm,
  loading,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  requireText?: string;
  onConfirm: () => void;
  loading?: boolean;
  /** What the action will do, in figures, above the buttons. */
  children?: ReactNode;
}) {
  const [typed, setTyped] = useState('');
  const blocked = !!requireText && typed !== requireText;

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title} description={description} size="sm">
      {children ? <div className="mb-4">{children}</div> : null}
      {requireText ? (
        <div className="space-y-2">
          <p className="text-body text-ink-muted">
            Type <span className="font-mono font-medium text-ink">{requireText}</span> to continue.
          </p>
          <Input value={typed} onChange={(event) => setTyped(event.target.value)} autoFocus />
        </div>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="danger" disabled={blocked} loading={loading} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
