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
   * A group whose `clear()` also drops every result this function has cached. Each call of this function also drops
   * the expired results of every live function in the group, not only its own.
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
  /** Drops the expired results of every live function in the group. */
  sweepExpired: (now: number) => void;
}

/** One memoized function's cache as registered with a `MemoizeGroup`. */
export interface MemoizeGroupMember {
  clear: () => void;
  /** Drops the expired results, visiting only results that have expired since the previous call. */
  sweepExpired: (now: number) => void;
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
    sweepExpired: (now) => forEachLiveMember((member) => member.sweepExpired(now)),
  };
}

type Cache<R> = Map<string, { value: R; expiresAt: number }>;

const MIN_QUEUE_COMPACTION_LENGTH = 64;

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
  const cache = createExpiringCache<R>();
  // The returned function references `member`, which keeps the group's weak registration alive exactly as long as the
  // function.
  const member: MemoizeGroupMember = { clear: cache.clear, sweepExpired: cache.dropExpired };
  group?.add(member);
  return (...args) => {
    const cacheKey = key(...args);
    const now = Date.now();
    (group ?? member).sweepExpired(now);
    const cachedEntry = takeUnexpiredEntry(cache.entries, cacheKey, now);
    if (cachedEntry) return cachedEntry.value;

    const value = fn(...args);
    // The TTL starts when the result is ready, not at the lookup before a possibly slow `fn`.
    cache.set(cacheKey, value, Date.now() + ttlMs);
    if (cache.entries.size > maxSize) cache.entries.delete(cache.entries.keys().next().value as string);
    if (value instanceof Promise) evictOnRejection(cache.entries, cacheKey, value);
    return value;
  };
}

interface ExpiringCache<R> {
  entries: Cache<R>;
  set: (key: string, value: R, expiresAt: number) => void;
  /** Drops the entries that have expired, visiting only queue items that have expired since the previous call. */
  dropExpired: (now: number) => void;
  clear: () => void;
}

function createExpiringCache<R>(): ExpiringCache<R> {
  const entries: Cache<R> = new Map();
  // One memoized function has one TTL, so insertion order is also expiration order.
  let expiryQueue: { key: string; expiresAt: number }[] = [];
  let queueHead = 0;
  const compactQueue = (): void => {
    expiryQueue = expiryQueue.slice(queueHead).filter((item) => entries.get(item.key)?.expiresAt === item.expiresAt);
    queueHead = 0;
  };
  return {
    entries,
    set: (key, value, expiresAt) => {
      entries.set(key, { value, expiresAt });
      if (!Number.isFinite(expiresAt)) return;
      expiryQueue.push({ key, expiresAt });
      // Evicted and overwritten keys leave stale items behind; compacting once they outnumber the cached entries keeps
      // the queue proportional to the cache at an amortized constant cost per insertion.
      if (expiryQueue.length - queueHead > 2 * entries.size + MIN_QUEUE_COMPACTION_LENGTH) compactQueue();
    },
    dropExpired: (now) => {
      while (queueHead < expiryQueue.length && (expiryQueue[queueHead]?.expiresAt ?? now) <= now) {
        const item = expiryQueue[queueHead++];
        if (item && entries.get(item.key)?.expiresAt === item.expiresAt) entries.delete(item.key);
      }
      if (queueHead > MIN_QUEUE_COMPACTION_LENGTH && queueHead * 2 > expiryQueue.length) compactQueue();
    },
    clear: () => {
      entries.clear();
      expiryQueue = [];
      queueHead = 0;
    },
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
