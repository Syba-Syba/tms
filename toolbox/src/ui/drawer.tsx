import * as Dialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export function Drawer({
  open,
  onOpenChange,
  title,
  children,
  footer,
  side = 'right',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  side?: 'right' | 'bottom';
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          className={cn(
            'fixed flex flex-col border-line bg-surface shadow-lg focus:outline-none',
            side === 'right' && 'inset-y-0 right-0 w-full max-w-md border-l',
            side === 'bottom' && 'inset-x-0 bottom-0 max-h-[85dvh] rounded-t-lg border-t',
          )}
        >
          {side === 'bottom' ? (
            <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-neutral-300" aria-hidden />
          ) : null}
          <div className="flex items-center justify-between border-b border-line px-5 py-4">
            <Dialog.Title className="font-display text-base font-semibold text-ink">
              {title}
            </Dialog.Title>
            <Dialog.Close className="text-ink-muted hover:text-ink" aria-label="Close">
              x
            </Dialog.Close>
          </div>
          <div className="flex-1 overflow-auto px-5 py-4">{children}</div>
          {footer ? <div className="border-t border-line px-5 py-3">{footer}</div> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
