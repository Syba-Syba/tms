import { QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderOptions } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { createQueryClient } from '../data/query';
import { ThemeProvider } from '../ui/theme-provider';
import { ToastProvider } from '../ui/toast';

/** One wrapper so tests never fail on a missing provider. */
export function renderWithProviders(ui: ReactElement, options?: RenderOptions) {
  const client = createQueryClient();
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <ToastProvider>{children}</ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
  return render(ui, { wrapper: Wrapper, ...options });
}

export const buildList = <T,>(count: number, factory: (index: number) => T): T[] =>
  Array.from({ length: count }, (_, i) => factory(i));

export * from '@testing-library/react';
