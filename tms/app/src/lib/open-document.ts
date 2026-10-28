import { useCallback } from 'react';
import { useToast } from '@hlonie/toolbox/ui';
import { humanError, openDocument } from '../api/client';

/**
 * openDocument with its failure shown rather than swallowed. Every screen called it bare
 * from an onClick, so an expired session or a missing file produced an unhandled rejection
 * and a button that did nothing.
 */
export function useOpenDocument() {
  const toast = useToast();
  return useCallback(
    (key: string | (() => Promise<string>)) =>
      openDocument(key).catch((error: unknown) => {
        toast.show({ title: 'Could not open the document', description: humanError(error), tone: 'danger' });
      }),
    [toast],
  );
}
