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

export async function withRetry<T>(
  func: (failedCount: number) => Promise<T>,
  retryCount = 3,
  log?: (message: string) => void
): Promise<T> {
  let failedCount = 0;
  for (;;) {
    try {
      return await func(failedCount);
    } catch (error) {
      failedCount++;
      if (failedCount >= retryCount) {
        throw error;
      }
      log?.(`Retry due to: ${error instanceof Error ? error.stack : error}`);
    }
  }
}
