import type { UploadState } from '@hlonie/toolbox/ui';

/**
 * Uploads every entry that has not landed yet and returns how many failed. Entries already
 * synced are skipped, so a retry sends only the photos that failed, never a second copy.
 */
export async function uploadPending<T extends { state: UploadState }>(
  entries: T[],
  upload: (entry: T) => Promise<void>,
  mark: (index: number, state: UploadState) => void,
): Promise<number> {
  let failed = 0;
  for (const [index, entry] of entries.entries()) {
    if (entry.state === 'synced') continue;
    try {
      mark(index, 'uploading');
      await upload(entry);
      mark(index, 'synced');
    } catch {
      failed += 1;
      mark(index, 'failed');
    }
  }
  return failed;
}

/**
 * Creates a lease, then renders its document. The two are separate calls: once the create
 * has succeeded the lease exists, and asking again only gets a 409, so a failed render is
 * reported with the lease id for the review screen (which can render it) instead of thrown.
 */
export async function createAndRender(
  create: () => Promise<{ id: string }>,
  render: (leaseId: string) => Promise<unknown>,
): Promise<{ leaseId: string; rendered: boolean; renderError?: unknown }> {
  const { id } = await create();
  try {
    await render(id);
    return { leaseId: id, rendered: true };
  } catch (renderError) {
    return { leaseId: id, rendered: false, renderError };
  }
}
