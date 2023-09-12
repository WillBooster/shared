import { sleep } from './sleep.js';

/**
 * Convert an object to an error.
 * @param obj The object to convert.
 */
export function errorify(obj: unknown): Error {
  if (obj instanceof Error) return obj;
  if (typeof obj === 'string') return new Error(obj);
  try {
    return new Error(JSON.stringify(obj));
  } catch {
    return new Error(String(obj));
  }
}

export function ignoreError<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    // do nothing
  }
}

export function ignoreEnoent<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

export async function ignoreErrorAsync<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    // do nothing
  }
}

export async function ignoreEnoentAsync<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

/**
 * Retry the given function.
 * @param func The function to retry.
 * @param beforeRetry The function to call immediately before retrying.
 * @param handleError The function to call when an error occurs.
 * @param retryCount The maximum number of retries.
 * @param retryLogger The function to log retrying.
 * @param sleepMilliseconds The number of milliseconds to sleep before retrying.
 */
export async function withRetry<T>(
  func: (failedCount: number) => Promise<T>,
  {
    beforeRetry = undefined as ((error: unknown) => Promise<void>) | undefined,
    handleError = undefined as ((error: unknown) => Promise<void>) | undefined,
    retryCount = 3,
    retryLogger = undefined as ((message: string) => void) | undefined,
    sleepMilliseconds = 0,
  }
): Promise<T> {
  let failedCount = 0;
  for (;;) {
    try {
      return await func(failedCount);
    } catch (error) {
      await handleError?.(error);
      failedCount++;
      if (failedCount >= retryCount) {
        throw error;
      }
      if (sleepMilliseconds > 0) {
        await sleep(sleepMilliseconds);
      }
      retryLogger?.(`Retry due to: ${error instanceof Error ? error.stack : error}`);
      await beforeRetry?.(error);
    }
  }
}
