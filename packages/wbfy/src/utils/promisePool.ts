import { PromisePool } from 'minimal-promise-pool';

export const promisePool = new PromisePool();

/**
 * Runs every task in `promisePool` and rejects with the first error only after all of them settle,
 * so a caller that catches the error never proceeds while a sibling write is still running.
 */
export async function runAllInPool(tasks: readonly (() => Promise<unknown>)[]): Promise<void> {
  const results = await Promise.allSettled(tasks.map((task) => promisePool.runAndWaitForReturnValue(task)));
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason;
  }
}
