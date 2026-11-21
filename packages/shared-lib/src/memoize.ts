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
  /**
   * A group whose `clear()` also drops every result this function has cached. Each call of this function also runs the
   * periodic sweep of expired results that is due in any live function of the group, not only in this one.
   */
  group?: MemoizeGroup;
}

/**
 * The caches of the functions memoized with it as `group`. Its members are plain objects, so a group created by one
 * copy of this package also works with `memoize` from another copy of the same version (e.g., another bundle).
 */
export interface MemoizeGroup {
  /** Registers one memoized function's cache. The group holds it weakly, so it lives only as long as that function. */
  add: (member: MemoizeGroupMember) => void;
  /** Drops the cached results of every live function in the group, so that their next calls recompute. */
  clear: () => void;
  /** Runs the due sweep of expired results in every live function of the group. */
  sweepExpiredIfDue: (now: number) => void;
}

/** One memoized function's cache as registered with a `MemoizeGroup`. */
export interface MemoizeGroupMember {
  clear: () => void;
  /** Drops the expired results if this function's sweep, at most once per its TTL, is due. */
  sweepExpiredIfDue: (now: number) => void;
}

/** Creates a `MemoizeGroup`; pass it as the `group` option of each `memoize` call whose cache it should manage. */
export function createMemoizeGroup(): MemoizeGroup {
  const members = new Set<WeakRef<MemoizeGroupMember>>();
  const forEachLiveMember = (action: (member: MemoizeGroupMember) => void): void => {
    for (const memberRef of members) {
      const member = memberRef.deref();
      if (member) action(member);
      else members.delete(memberRef);
    }
  };
  return {
    add: (member) => members.add(new WeakRef(member)),
    clear: () => forEachLiveMember((member) => member.clear()),
    sweepExpiredIfDue: (now) => forEachLiveMember((member) => member.sweepExpiredIfDue(now)),
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
  // The returned function references `member`, which keeps the group's weak registration alive exactly as long as the
  // function.
  // Sweeping at most once per TTL, on any call, bounds the cache to results inserted within the last two TTLs
  // whatever the key pattern, at an amortized cost of one entry visit per insertion.
  let nextSweepAt = 0;
  const member: MemoizeGroupMember = {
    clear: () => cache.clear(),
    sweepExpiredIfDue: (now) => {
      if (now < nextSweepAt) return;
      sweepExpiredEntries(cache, now);
      nextSweepAt = now + ttlMs;
    },
  };
  group?.add(member);
  return (...args) => {
    const cacheKey = key(...args);
    const now = Date.now();
    (group ?? member).sweepExpiredIfDue(now);
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
