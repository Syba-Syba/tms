export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  factor?: number;
  shouldRetry?: (error: unknown) => boolean;
}

/** Exponential backoff with jitter so parallel clients do not retry in lockstep. */
export async function retry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { attempts = 3, baseDelayMs = 300, factor = 2, shouldRetry = () => true } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1 || !shouldRetry(error)) break;
      const delay = baseDelayMs * factor ** attempt;
      await sleep(delay + Math.random() * baseDelayMs);
    }
  }
  throw lastError;
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message = 'Request timed out') {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

/** Runs tasks with a fixed concurrency, the pattern used for parallel photo uploads. */
export async function pool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index] as T, index);
    }
  });

  await Promise.all(runners);
  return results;
}
