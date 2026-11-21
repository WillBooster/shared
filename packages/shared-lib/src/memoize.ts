export interface MemoizeOptions<Args extends unknown[]> {
  /**
   * Derives the cache key from the arguments. Defaults to `JSON.stringify(args)`, which gives the same key to
   * arguments JSON does not distinguish (e.g., `undefined`, `null`, and `NaN`; a `Map` and `{}`), so pass `key`
   * when such arguments must produce different results.
   */
  key?: (...args: Args) => string;
  /** The maximum number of cached results; the least recently used one is evicted first. Defaults to no limit. */
  maxSize?: number;
  /** How long a cached result stays valid, in milliseconds. Defaults to forever. */
  ttlMs?: number;
  /** A group whose `clear()` also drops every result this function has cached. */
  group?: MemoizeGroup;
}

/**
 * Clears the caches of every function memoized with it as `group`. Its methods are all a memoized function uses, so a
 * group created by one copy of this package also works with `memoize` from another copy (e.g., another bundle).
 */
export interface MemoizeGroup {
  /** Registers a callback that drops one function's cached results. */
  add: (clearCache: () => void) => void;
  /** Drops the cached results of every function in the group, so that their next calls recompute. */
  clear: () => void;
}

/** Creates a `MemoizeGroup`; pass it as the `group` option of each `memoize` call whose cache it should clear. */
export function createMemoizeGroup(): MemoizeGroup {
  const cacheClearers = new Set<() => void>();
  return {
    add: (clearCache) => cacheClearers.add(clearCache),
    clear: () => {
      for (const clearCache of cacheClearers) clearCache();
    },
  };
}

type Cache<R> = Map<string, { value: R; expiresAt: number }>;

/**
 * Returns a function that caches the results of `fn` by the key of its arguments.
 * A returned promise is cached too, and dropped from the cache when it rejects so that the next call retries.
 */
export function memoize<Args extends unknown[], R>(
  fn: (...args: Args) => R,
  {
    key = (...args) => JSON.stringify(args),
    maxSize = Number.POSITIVE_INFINITY,
    ttlMs = Number.POSITIVE_INFINITY,
    group,
  }: MemoizeOptions<Args> = {}
): (...args: Args) => R {
  const cache: Cache<R> = new Map();
  group?.add(() => cache.clear());
  // Sweeping at most once per TTL, on any call, bounds the cache to results inserted within the last two TTLs
  // whatever the key pattern, at an amortized cost of one entry visit per insertion.
  let nextSweepAt = 0;
  return (...args) => {
    const cacheKey = key(...args);
    const now = Date.now();
    if (now >= nextSweepAt) {
      sweepExpiredEntries(cache, now);
      nextSweepAt = now + ttlMs;
    }
    const cachedEntry = takeUnexpiredEntry(cache, cacheKey, now);
    if (cachedEntry) return cachedEntry.value;

    const value = fn(...args);
    // The TTL starts when the result is ready, not at the lookup before a possibly slow `fn`.
    cache.set(cacheKey, { value, expiresAt: Date.now() + ttlMs });
    if (cache.size > maxSize) cache.delete(cache.keys().next().value as string);
    if (value instanceof Promise) evictOnRejection(cache, cacheKey, value);
    return value;
  };
}

function takeUnexpiredEntry<R>(cache: Cache<R>, cacheKey: string, now: number): { value: R } | undefined {
  const entry = cache.get(cacheKey);
  if (!entry) return undefined;
  // Re-inserting moves the entry to the end of the Map's insertion order, which serves as the LRU order.
  cache.delete(cacheKey);
  if (entry.expiresAt <= now) return undefined;
  cache.set(cacheKey, entry);
  return entry;
}

function sweepExpiredEntries(cache: Cache<unknown>, now: number): void {
  for (const [entryKey, { expiresAt }] of cache) {
    if (expiresAt <= now) cache.delete(entryKey);
  }
}

function evictOnRejection(cache: Cache<unknown>, cacheKey: string, promise: Promise<unknown>): void {
  promise.catch(() => {
    if (cache.get(cacheKey)?.value === promise) cache.delete(cacheKey);
  });
}

/** A getter decorator that computes the value once per instance, on the first access. */
export function cached<This extends object, R>(
  getter: (this: This) => R,
  _context: ClassGetterDecoratorContext<This, R>
): (this: This) => R {
  const values = new WeakMap<This, R>();
  return function (this: This): R {
    if (values.has(this)) return values.get(this) as R;
    const value = getter.call(this);
    values.set(this, value);
    return value;
  };
}
