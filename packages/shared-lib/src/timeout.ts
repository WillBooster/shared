export type RaceWithTimeoutResult<T> = { timedOut: false; value: T } | { timedOut: true };

/**
 * Waits for `promise` for at most `timeoutMilliseconds`. A rejection of `promise` within the limit propagates.
 * The timer is cleared as soon as either side settles, so it never keeps a process alive after the race.
 * `promise` itself is not canceled on timeout; pass an `AbortSignal` to the underlying work for that.
 */
export async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMilliseconds: number
): Promise<RaceWithTimeoutResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ timedOut: false as const, value })),
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMilliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
