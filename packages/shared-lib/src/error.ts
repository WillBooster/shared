import { sleep } from './sleep.js';

/**
 * Convert an object to an error.
 * @param obj The object to convert.
 */
export function errorify(obj: unknown): Error {
  if (obj instanceof Error) return obj;
  if (typeof obj === 'string') return new Error(obj);
  // `JSON.stringify` answers `undefined` for `undefined`, a symbol and a function, and throws
  // on a bigint or a cycle; `new Error(undefined)` has an empty message, which would drop the
  // only diagnostic a caller has about such a thrown value. Neither representation may throw
  // out of here: this runs in a catch block, where it would replace the error it converts.
  return new Error(ignoreError(() => JSON.stringify(obj)) ?? ignoreError(() => String(obj)));
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

export interface RetryOptions {
  beforeRetry?: (error: unknown) => Promise<void>;
  handleError?: (error: unknown) => Promise<void>;
  /**
   * The maximum number of total attempts, including the initial attempt.
   * For example, `retryCount: 3` runs the function at most 3 times: 1 initial attempt and up to 2 retries.
   */
  retryCount?: number;
  retryLogger?: (message: string) => void;
  shouldRetry?: (error: unknown) => boolean;
  /**
   * Decides how long to wait before retrying after `error`, given the backoff `sleepMilliseconds` it would otherwise wait,
   * e.g. `(error, ms) => Math.max(ms, retryAtOf(error) - Date.now())` to honor a retry time sent by a server.
   * It does not affect the backoff that `updateSleepMilliseconds` advances.
   */
  getSleepMilliseconds?: (error: unknown, sleepMilliseconds: number) => number;
  sleepMilliseconds?: number;
  updateSleepMilliseconds?: (sleepMilliseconds: number) => number;
}

/**
 * Retry the given function.
 * @param func The function to retry.
 * @param beforeRetry The function to call immediately before retrying.
 * @param handleError The function to call when an error occurs.
 * @param retryCount The maximum number of total attempts, including the initial attempt.
 * @param retryLogger The function to log retrying.
 * @param sleepMilliseconds The number of milliseconds to sleep before retrying.
 * @param updateSleepMilliseconds The function to update sleep milliseconds after each retry.
 */
export async function withRetry<T>(
  func: (failedCount: number) => T | Promise<T>,
  {
    beforeRetry,
    handleError,
    retryCount = 3,
    retryLogger,
    shouldRetry,
    getSleepMilliseconds,
    sleepMilliseconds = 0,
    updateSleepMilliseconds,
  }: RetryOptions = {}
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
      if (shouldRetry && !shouldRetry(error)) {
        throw error;
      }
      const currentSleepMilliseconds = getSleepMilliseconds?.(error, sleepMilliseconds) ?? sleepMilliseconds;
      if (currentSleepMilliseconds > 0) {
        await sleep(currentSleepMilliseconds);
      }
      if (updateSleepMilliseconds) {
        sleepMilliseconds = updateSleepMilliseconds(sleepMilliseconds);
      }
      retryLogger?.(`Retry due to: ${error}
${error instanceof Error ? '---\n' + (error.stack ?? '') : ''}`);
      await beforeRetry?.(error);
    }
  }
}
