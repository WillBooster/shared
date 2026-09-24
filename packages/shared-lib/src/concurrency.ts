/**
 * Runs `action` for every item with at most `concurrency` actions in flight, starting the next item as soon as any
 * action settles, so one slow item does not hold back a whole batch. After an action rejects, no further item is
 * started, and the returned promise rejects with the first error once it is known.
 */
export async function forEachConcurrently<T>(
  items: Iterable<T>,
  concurrency: number,
  action: (item: T) => Promise<void>
): Promise<void> {
  const iterator = items[Symbol.iterator]();
  let failed = false;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (let next = iterator.next(); !failed && !next.done; next = iterator.next()) {
        try {
          await action(next.value);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    })
  );
}
