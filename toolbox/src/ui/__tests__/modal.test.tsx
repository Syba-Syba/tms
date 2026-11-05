import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Modal } from '../modal';
import { Drawer } from '../drawer';

describe('Modal', () => {
  it('caps its height to the viewport and scrolls, so a tall form keeps its buttons reachable on a small phone', () => {
    render(
      <Modal open onOpenChange={() => {}} title="Notice" footer={<button>Send</button>}>
        <p>Body</p>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('max-h-[calc(100dvh-2rem)]');
    expect(dialog.className).toContain('flex-col');
    const body = screen.getByText('Body').parentElement!;
    expect(body.className).toContain('overflow-y-auto');
  });
});

describe('Drawer', () => {
  it('scrolls its body on both sides', () => {
    render(
      <Drawer open onOpenChange={() => {}} title="Filters" side="bottom">
        <p>Inside</p>
      </Drawer>,
    );
    expect(screen.getByText('Inside').parentElement!.className).toContain('overflow-auto');
    expect(screen.getByRole('dialog').className).toContain('max-h-[85dvh]');
  });
});
