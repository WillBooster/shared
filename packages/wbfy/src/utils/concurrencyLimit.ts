import { createConcurrencyLimiter } from '@willbooster/shared-lib/src';

export const runWithConcurrencyLimit = createConcurrencyLimiter(10);

/**
 * Runs every task with `runWithConcurrencyLimit` and rejects with the first error only after all of them settle,
 * so a caller that catches the error never proceeds while a sibling write is still running.
 */
export async function runAllWithConcurrencyLimit(tasks: readonly (() => Promise<unknown>)[]): Promise<void> {
  const results = await Promise.allSettled(tasks.map((task) => runWithConcurrencyLimit(task)));
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason;
  }
}
