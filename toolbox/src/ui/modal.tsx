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
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-40 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-line bg-surface shadow-lg focus:outline-none',
            widths[size],
          )}
        >
          <div className="shrink-0 border-b border-line-soft px-6 pb-4 pt-5">
            <Dialog.Title className="text-title font-bold text-ink">
              {title}
            </Dialog.Title>
            {description ? (
              <Dialog.Description className="mt-1 text-body text-ink-muted">
                {description}
              </Dialog.Description>
            ) : null}
          </div>
          {/* Only the body scrolls, so the title and the buttons stay on screen however tall the form is. */}
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
          {footer ? (
            <div className="flex shrink-0 flex-wrap justify-end gap-2 rounded-b-lg border-t border-line-soft bg-surface-muted px-6 py-4">{footer}</div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export const ModalClose = Dialog.Close;
