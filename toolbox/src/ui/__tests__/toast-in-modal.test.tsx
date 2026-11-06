import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { Modal } from '../modal';
import { ToastProvider, useToast } from '../toast';

function Screen() {
  const toast = useToast();
  const [open, setOpen] = useState(true);
  return (
    <>
    <p>Behind the dialog</p>
    <Modal open={open} onOpenChange={setOpen} title="Record a payment">
      <button type="button" onClick={() => toast.show({ title: 'Overpaying is rejected', tone: 'danger' })}>
        Save
      </button>
    </Modal>
    </>
  );
}

/** Audit 5 item 41: a refusal toasted while a Modal is open must still reach a screen reader. */
describe('a toast raised while a Modal is open', () => {
  it('is not under anything the dialog hides from assistive technology', async () => {
    render(
      <ToastProvider>
        <Screen />
      </ToastProvider>,
    );
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    // The dialog does hide the page behind it, so the check below means something.
    expect(screen.getByText('Behind the dialog').closest('[aria-hidden="true"]')).not.toBeNull();
    const message = screen.getByText('Overpaying is rejected');
    const region = message.closest('[aria-live]');
    expect(region).not.toBeNull();
    for (let node: HTMLElement | null = message; node; node = node.parentElement) {
      expect(node.getAttribute('aria-hidden')).not.toBe('true');
      expect(node.hasAttribute('inert')).toBe(false);
    }
  });
});
