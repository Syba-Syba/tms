import * as Dialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}) {
  const widths = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl' };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/45" />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-40 w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-md border border-line bg-surface shadow-lg focus:outline-none',
            widths[size],
          )}
        >
          <div className="border-b border-line px-5 py-4">
            <Dialog.Title className="text-[16px] font-semibold text-ink">
              {title}
            </Dialog.Title>
            {description ? (
              <Dialog.Description className="mt-1 text-sm text-ink-muted">
                {description}
              </Dialog.Description>
            ) : null}
          </div>
          <div className="px-5 py-4">{children}</div>
          {footer ? (
            <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export const ModalClose = Dialog.Close;
