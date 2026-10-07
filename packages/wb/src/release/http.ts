// crates.io rejects requests with a generic User-Agent.
export const userAgent = 'willbooster-wb-release (https://github.com/WillBooster/shared)';

// Seconds to wait before each retry of a request that failed transiently.
const retryDelays = [1, 2, 4, 8, 16];
// GitHub asks to wait at least a minute after a secondary rate limit that states no time.
const defaultRateLimitDelay = 60;
// A rate limit that lasts longer fails the run instead, which a re-run completes.
const maxRetryDelay = 300;

export interface RetryOptions {
  /** Looks for what a POST that may have been processed created. */
  findCreated?: () => Promise<unknown>;
  /** Whether a POST may be repeated after a failure that the server may have processed. */
  repeatable?: boolean;
}

export type GitHubClient = (method: string, route: string, body?: unknown, options?: RetryOptions) => Promise<unknown>;

/**
 * The returned client never repeats a POST after a failure that GitHub may have processed, since a listing cannot prove
 * that the POST created nothing, unless the POST is `repeatable`. `findCreated` then looks for what it created, which
 * the client returns if found.
 */
export function createGitHubClient(env: Record<string, string | undefined>): GitHubClient {
  return async (method, route, body, options) => {
    const response = await fetchWithRetry(
      `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/${route}`,
      {
        method,
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${env.GITHUB_TOKEN}` },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      },
      options
    );
    if (!response.ok) throw new Error(`${method} ${route} failed: ${response.status} ${await response.text()}`);
    return response.status === 204 ? undefined : response.json();
  };
}

/**
 * Fetches `url`, retrying a dropped connection, a 5xx response, and a rate limit. Unlike a rate-limited request, the
 * others may have been processed, so a POST is not repeated after them unless it is `repeatable`, and a repeated DELETE
 * that finds nothing left to delete succeeds.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  { findCreated, repeatable }: RetryOptions = {}
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const result = await fetchWholeResponse(url, init);
    const response = result instanceof Response ? result : undefined;
    if (attempt > 0 && init.method === 'DELETE' && response && (await isAbsent(response))) {
      return new Response(undefined, { status: 204 });
    }
    const rateLimitDelay = response && (await getRateLimitDelay(response));
    if (response && rateLimitDelay === undefined && response.status < 500) return response;
    const isUncertainPost = init.method === 'POST' && !repeatable && rateLimitDelay === undefined;
    const delay = isUncertainPost ? retryDelays[0]! : Math.max(retryDelays[attempt] ?? Infinity, rateLimitDelay ?? 0);
    if (delay > maxRetryDelay || (isUncertainPost && !findCreated)) return unwrapResponse(result);

    const reason = response ? `${response.status} ${response.statusText}` : 'a dropped connection';
    const action = isUncertainPost ? 'Looking for the result of' : 'Retrying';
    console.info(`${action} ${init.method ?? 'GET'} ${url} in ${Math.ceil(delay)} seconds after ${reason}`);
    await new Promise((resolve) => setTimeout(resolve, delay * 1000));
    if (isUncertainPost && findCreated) {
      const created = await findCreated();
      return created ? Response.json(created) : unwrapResponse(result);
    }
  }
}

/** Resolves to the connection error instead of rejecting when the connection fails or drops. */
async function fetchWholeResponse(url: string, init: RequestInit): Promise<Response | TypeError> {
  try {
    const received = await fetch(url, init);
    // Read here so that a connection dropped while receiving the body is retried too.
    const body = await received.arrayBuffer();
    return new Response(body.byteLength > 0 ? body : undefined, received);
  } catch (error) {
    // fetch and reading the body reject with a TypeError when the connection fails or drops.
    if (!(error instanceof TypeError)) throw error;
    return error;
  }
}

function unwrapResponse(result: Response | TypeError): Response {
  if (result instanceof TypeError) throw result;
  return result;
}

/** Returns whether the response reports that the target does not exist. */
async function isAbsent(response: Response): Promise<boolean> {
  if (response.status === 404) return true;
  // GitHub reports a missing Git reference with a 422 response, which also reports other validation failures.
  const text = await response.clone().text();
  return response.status === 422 && text.includes('"Reference does not exist"');
}

/** Returns the seconds to wait before repeating a rate-limited request, or `undefined` for another response. */
async function getRateLimitDelay(response: Response): Promise<number | undefined> {
  const isRateLimited =
    response.status === 429 || (response.status === 403 && /rate limit/i.test(await response.clone().text()));
  if (!isRateLimited) return;
  const now = Date.now() / 1000;
  // Either seconds or an HTTP date.
  const retryAfter = response.headers.get('retry-after') ?? '';
  const reset = response.headers.get('x-ratelimit-remaining') === '0' && response.headers.get('x-ratelimit-reset');
  const delays = [
    /^\d+$/.test(retryAfter) ? Number(retryAfter) : Date.parse(retryAfter) / 1000 - now,
    reset ? Number(reset) - now : Number.NaN,
  ];
  const statedDelays = delays.filter((delay) => Number.isFinite(delay));
  return statedDelays.length > 0 ? Math.max(...statedDelays) : defaultRateLimitDelay;
}
