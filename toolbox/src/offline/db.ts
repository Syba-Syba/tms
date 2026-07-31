import Dexie, { type Table } from 'dexie';

export interface QueuedRequest {
  id?: number;
  url: string;
  method: string;
  body?: unknown;
  createdAt: number;
  attempts: number;
  lastError?: string;
}

export interface DraftRecord {
  key: string;
  payload: unknown;
  updatedAt: number;
  version: number;
}

export class ToolboxDb extends Dexie {
  queue!: Table<QueuedRequest, number>;
  drafts!: Table<DraftRecord, string>;

  constructor(name = 'toolbox') {
    super(name);
    this.version(1).stores({
      queue: '++id, createdAt',
      drafts: 'key, updatedAt',
    });
  }
}

export const db = new ToolboxDb();

/** Version check prevents a slow tab from overwriting a newer draft. */
export async function saveDraft(key: string, payload: unknown, expectedVersion?: number) {
  return db.transaction('rw', db.drafts, async () => {
    const current = await db.drafts.get(key);
    if (expectedVersion !== undefined && current && current.version !== expectedVersion) {
      throw new Error('Draft changed elsewhere. Reload before saving.');
    }
    const next = { key, payload, updatedAt: Date.now(), version: (current?.version ?? 0) + 1 };
    await db.drafts.put(next);
    return next;
  });
}
