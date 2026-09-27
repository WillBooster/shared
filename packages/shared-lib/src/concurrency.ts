/**
 * Runs `action` for every item with at most `concurrency` actions in flight, starting the next item as soon as any
 * action settles, so one slow item does not hold back a whole batch. After an action rejects, no further item is
 * started, and once every started action has settled, the returned promise rejects with the first error.
 * The returned promise rejects with a `RangeError` when `concurrency` is not a positive integer.
 */
export async function forEachConcurrently<T>(
  items: readonly T[],
  concurrency: number,
  action: (item: T, index: number) => Promise<unknown>
): Promise<void> {
  await runConcurrently(items.length, concurrency, (index) => action(items[index] as T, index));
}

/**
 * Like `forEachConcurrently`, but resolves with the results of `mapper` in the order of `items`.
 */
export async function mapConcurrently<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = Array.from<R>({ length: items.length });
  await runConcurrently(items.length, concurrency, async (index) => {
    results[index] = await mapper(items[index] as T, index);
  });
  return results;
}

async function runConcurrently(
  length: number,
  concurrency: number,
  run: (index: number) => Promise<unknown>
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`concurrency must be a positive integer: ${concurrency}`);
  }
  let nextIndex = 0;
  let failure: { error: unknown } | undefined;
  // Workers beyond the item count would find nothing to take, so they are not created.
  await Promise.all(
    Array.from({ length: Math.min(concurrency, length) }, async () => {
      while (!failure && nextIndex < length) {
        try {
          await run(nextIndex++);
        } catch (error) {
          failure ??= { error };
        }
      }
    })
  );
  if (failure) throw failure.error;
}
