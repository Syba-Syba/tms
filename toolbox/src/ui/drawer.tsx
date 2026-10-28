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
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          className={cn(
            'fixed z-40 flex flex-col border-line bg-surface shadow-lg focus:outline-none',
            side === 'right' && 'inset-y-0 right-0 w-full max-w-md border-l',
            side === 'bottom' && 'inset-x-0 bottom-0 max-h-[85dvh] rounded-t-md border-t',
          )}
        >
          {side === 'bottom' ? (
            <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-neutral-300" aria-hidden />
          ) : null}
          <div className="flex items-center justify-between border-b border-line px-5 py-2.5">
            <Dialog.Title className="text-[16px] font-semibold text-ink">
              {title}
            </Dialog.Title>
            <Dialog.Close aria-label="Close"
              className="-mr-3 inline-flex h-11 w-11 items-center justify-center rounded-sm text-[18px] text-ink-muted hover:bg-surface-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tb-ring)]">
              <span aria-hidden>×</span>
            </Dialog.Close>
          </div>
          <div className="flex-1 overflow-auto px-5 py-4">{children}</div>
          {footer ? <div className="border-t border-line px-5 py-3">{footer}</div> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
