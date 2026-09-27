/** Whether a value is a non-null object other than an array, e.g. a parsed JSON object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Returns a shallow copy of the own enumerable string-keyed properties whose values are not `undefined`,
 * e.g. to turn `process.env` into a `Record<string, string>`.
 */
export function omitUndefined<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const propertyValue = (value as Record<string, unknown>)[key];
    if (propertyValue !== undefined) result[key] = propertyValue;
  }
  return result as { [K in keyof T]: Exclude<T[K], undefined> };
}
