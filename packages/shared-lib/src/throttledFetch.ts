import { sleep } from './sleep.js';

export interface ThrottledFetchOptions {
  /** The minimum interval between the starts of consecutive requests. */
  intervalMilliseconds: number;
  /** How long to hold later requests after a 429 response without a valid `Retry-After`. */
  rateLimitFallbackMilliseconds: number;
}

/**
 * Creates a `fetch` for a rate-limited API that starts requests in call order, at least `intervalMilliseconds` apart.
 * A 429 response holds every later request until its `Retry-After` (delay seconds or an HTTP date) elapses, including
 * requests already waiting; the 429 response itself is returned to the caller, not retried.
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
        await sleep(nextRequestAt - performance.now());
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

/** Parses `Retry-After` in either form RFC 9110 allows: delay seconds or an HTTP date. */
function parseRetryAfterMilliseconds(value: string | null): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return;
  const milliseconds = /^\d+$/u.test(trimmed) ? Number(trimmed) * 1000 : Date.parse(trimmed) - Date.now();
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : undefined;
}
