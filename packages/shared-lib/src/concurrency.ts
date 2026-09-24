/**
 * Runs `action` for every item with at most `concurrency` actions in flight, starting the next item as soon as any
 * action settles, so one slow item does not hold back a whole batch. After an action rejects, no further item is
 * started, and once every started action has settled, the returned promise rejects with the first error.
 */
export async function forEachConcurrently<T>(
  items: readonly T[],
  concurrency: number,
  action: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  let failure: { error: unknown } | undefined;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (!failure && nextIndex < items.length) {
        try {
          await action(items[nextIndex++] as T);
        } catch (error) {
          failure ??= { error };
        }
      }
    })
  );
  if (failure) throw failure.error;
}
