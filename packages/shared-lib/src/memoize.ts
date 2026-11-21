export interface MemoizeOptions<Args extends unknown[]> {
  /** Derives the cache key from the arguments. Defaults to `JSON.stringify(args)`. */
  key?: (...args: Args) => string;
  /** The maximum number of cached results; the least recently used one is evicted first. Defaults to no limit. */
  maxSize?: number;
  /** How long a cached result stays valid, in milliseconds. Defaults to forever. */
  ttlMs?: number;
}

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
  }: MemoizeOptions<Args> = {}
): (...args: Args) => R {
  const cache = new Map<string, { value: R; expiresAt: number }>();
  return (...args) => {
    const cacheKey = key(...args);
    const now = Date.now();
    const entry = cache.get(cacheKey);
    if (entry) {
      // Re-inserting moves the entry to the end of the Map's insertion order, which serves as the LRU order.
      cache.delete(cacheKey);
      if (entry.expiresAt > now) {
        cache.set(cacheKey, entry);
        return entry.value;
      }
    }
    const value = fn(...args);
    cache.set(cacheKey, { value, expiresAt: now + ttlMs });
    if (cache.size > maxSize) cache.delete(cache.keys().next().value as string);
    if (value instanceof Promise) {
      value.catch(() => {
        if (cache.get(cacheKey)?.value === value) cache.delete(cacheKey);
      });
    }
    return value;
  };
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
