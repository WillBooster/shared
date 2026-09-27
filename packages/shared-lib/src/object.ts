/** Whether a value is a non-null object other than an array, e.g. a parsed JSON object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Returns a shallow copy of the own enumerable string-keyed properties whose values are not `undefined`,
 * e.g. to turn `process.env` into a `Record<string, string>`.
 */
export function omitUndefined<T extends object>(value: T & NotArray<T>): WithoutUndefined<T> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const propertyValue = (value as Record<string, unknown>)[key];
    if (propertyValue === undefined) continue;
    if (key === '__proto__') {
      // Assignment would invoke the `__proto__` setter and replace the prototype instead of copying the key.
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: propertyValue,
        writable: true,
      });
    } else {
      result[key] = propertyValue;
    }
  }
  return result as WithoutUndefined<T>;
}

// A known key whose value may be `undefined` becomes optional because it may be omitted; an index signature, whose keys
// are never guaranteed to exist, keeps its shape so that `process.env` yields `Record<string, string>`. Symbol keys are
// not copied.
type WithoutUndefined<T> = {
  [
    K in keyof T as K extends symbol ? never : IsIndexKey<K> extends true ? K : undefined extends T[K] ? never : K
  ]: Exclude<T[K], undefined>;
} & {
  [
    K in keyof T as K extends symbol ? never : IsIndexKey<K> extends true ? never : undefined extends T[K] ? K : never
  ]?: Exclude<T[K], undefined>;
};

type IsIndexKey<K> = string extends K ? true : number extends K ? true : false;

// An array is rejected because the copy is a plain object without `length` or array methods.
type NotArray<T> = T extends readonly unknown[] ? never : unknown;
