import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// jsdom gaps the components expect filled.
class RO { observe() {} unobserve() {} disconnect() {} }
(globalThis as any).ResizeObserver ??= RO;
window.matchMedia ??= ((query: string) => ({
  matches: false, media: query, onchange: null,
  addListener: () => {}, removeListener: () => {},
  addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
})) as any;
Element.prototype.scrollIntoView ??= () => {};
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};

// Every document button funnels through window.open; capturing it lets a test download
// what the button opened and assert it is a real file.
export const openedUrls: string[] = [];
// openDocument first opens a blank tab inside the click, then points it at the signed link.
// The blank open is not a document, so only real URLs are recorded; returning null sends the
// app down its fallback, which opens the link itself.
window.open = ((url?: string) => { if (url) openedUrls.push(String(url)); return null; }) as any;

// The copy-link button writes to the clipboard.
export const copied: string[] = [];
Object.assign(navigator, { clipboard: { writeText: async (t: string) => { copied.push(t); } } });

// jsdom has no canvas, so the signature pad (canvas-backed) is the one stubbed component:
// it reports a drawn 1x1 PNG, which the API embeds into the sealed PDFs for real.
vi.mock('@hlonie/toolbox/ui', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { forwardRef, useImperativeHandle, createElement } = await import('react');
  const ONE_PX =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const SignaturePad = forwardRef((_props, ref) => {
    useImperativeHandle(ref, () => ({ isEmpty: () => false, toDataUrl: () => ONE_PX, clear: () => {} }));
    return createElement('div', { 'data-testid': 'signature-pad' }, 'signature pad');
  });
  return { ...actual, SignaturePad };
});

// jsdom refuses real navigation; the logout and 401 paths call location.assign, so capture it.
const assigned: string[] = [];
(window as any).__assignedUrls = assigned;
Object.defineProperty(window, 'location', {
  value: { ...window.location, assign: (url: string) => assigned.push(String(url)), reload: () => {} },
  writable: true,
});
