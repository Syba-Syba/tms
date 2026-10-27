import { describe, expect, it, vi } from 'vitest';
import type { UploadState } from '@hlonie/toolbox/ui';
import { createAndRender, uploadPending } from '../uploads';

describe('uploadPending', () => {
  it('retries only the photos that failed', async () => {
    const entries: { name: string; state: UploadState }[] = [
      { name: 'a', state: 'queued' },
      { name: 'b', state: 'queued' },
    ];
    const mark = (index: number, state: UploadState) => {
      entries[index] = { ...entries[index]!, state };
    };
    let flaky = true;
    const upload = vi.fn(async (entry: { name: string }) => {
      if (entry.name === 'b' && flaky) throw new Error('offline');
    });

    expect(await uploadPending(entries, upload, mark)).toBe(1);
    expect(entries.map((e) => e.state)).toEqual(['synced', 'failed']);

    flaky = false;
    upload.mockClear();
    expect(await uploadPending(entries, upload, mark)).toBe(0);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]![0].name).toBe('b');
    expect(entries.map((e) => e.state)).toEqual(['synced', 'synced']);
  });
});

describe('createAndRender', () => {
  it('keeps the lease id when only the render fails', async () => {
    const result = await createAndRender(
      async () => ({ id: 'lease-1' }),
      async () => {
        throw new Error('render down');
      },
    );
    expect(result).toMatchObject({ leaseId: 'lease-1', rendered: false });
  });

  it('throws when the lease itself was not created', async () => {
    await expect(
      createAndRender(
        async () => {
          throw new Error('409');
        },
        async () => undefined,
      ),
    ).rejects.toThrow('409');
  });
});
