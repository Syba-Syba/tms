import { db, type QueuedRequest } from './db';

export interface SyncQueueOptions {
  send: (request: QueuedRequest) => Promise<void>;
  onUnauthorised?: () => Promise<void>;
  maxAttempts?: number;
}

/** Drains oldest first and stops on 401 so a token refresh happens before the rest replays. */
export function createSyncQueue({ send, onUnauthorised, maxAttempts = 5 }: SyncQueueOptions) {
  let draining = false;

  async function enqueue(request: Omit<QueuedRequest, 'id' | 'createdAt' | 'attempts'>) {
    return db.queue.add({ ...request, createdAt: Date.now(), attempts: 0 });
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      const pending = await db.queue.orderBy('createdAt').toArray();
      for (const item of pending) {
        try {
          await send(item);
          await db.queue.delete(item.id as number);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('401') && onUnauthorised) {
            await onUnauthorised();
            break;
          }
          const attempts = item.attempts + 1;
          if (attempts >= maxAttempts) {
            await db.queue.delete(item.id as number);
          } else {
            await db.queue.update(item.id as number, { attempts, lastError: message });
          }
          break;
        }
      }
    } finally {
      draining = false;
    }
  }

  const size = () => db.queue.count();

  return { enqueue, drain, size };
}
