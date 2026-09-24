import { sleep } from './sleep.js';

// `setTimeout` fires after 1 ms for longer delays, which would turn a long `Retry-After` hold into a busy loop.
const MAX_TIMER_MILLISECONDS = 2_147_483_647;

export interface ThrottledFetchOptions {
  /** The minimum interval between the starts of consecutive requests. */
  intervalMilliseconds: number;
  /** How long to hold later requests after a 429 response without `Retry-After` in delay seconds or IMF-fixdate. */
  rateLimitFallbackMilliseconds: number;
}

/**
 * Creates a `fetch` for a rate-limited API that starts requests in call order, at least `intervalMilliseconds` apart.
 * A 429 response holds every later request until its `Retry-After` (delay seconds or an IMF-fixdate) elapses, including
 * requests already waiting; the 429 response itself is returned to the caller, not retried. An abort signal takes effect
 * only once its request starts, not while it waits in the queue.
 */
export function createThrottledFetch({
  intervalMilliseconds,
  rateLimitFallbackMilliseconds,
}: ThrottledFetchOptions): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  let nextRequestAt = 0;
  let admission = Promise.resolve();

  return async (input, init) => {
    const previousAdmission = admission;
    const ready = (async () => {
      await previousAdmission;
      // A response to an earlier request can push `nextRequestAt` back while this request sleeps.
      while (nextRequestAt > performance.now()) {
        await sleep(Math.min(nextRequestAt - performance.now(), MAX_TIMER_MILLISECONDS));
      }
      nextRequestAt = performance.now() + intervalMilliseconds;
    })();
    admission = ready;
    await ready;

    const response = await fetch(input, init);
    if (response.status === 429) {
      const waitMilliseconds = parseRetryAfterMilliseconds(response.headers.get('retry-after'));
      nextRequestAt = Math.max(nextRequestAt, performance.now() + (waitMilliseconds ?? rateLimitFallbackMilliseconds));
    }
    return response;
  };
}

// RFC 9110 requires senders to generate HTTP dates in this IMF-fixdate form, e.g. `Sun, 06 Nov 1994 08:49:37 GMT`.
// `Date.parse` alone would also accept malformed values such as `1.5`.
const IMF_FIXDATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/u;

/** Parses `Retry-After` in delay seconds or IMF-fixdate; the obsolete RFC 850 and asctime dates yield `undefined`. */
function parseRetryAfterMilliseconds(value: string | null): number | undefined {
  const trimmed = value?.trim() ?? '';
  const milliseconds = /^\d+$/u.test(trimmed)
    ? Number(trimmed) * 1000
    : IMF_FIXDATE.test(trimmed)
      ? Date.parse(trimmed) - Date.now()
      : Number.NaN;
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : undefined;
}
