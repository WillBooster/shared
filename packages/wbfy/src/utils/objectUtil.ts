export function moveToBottom<TObj extends Record<TKey, unknown>, TKey extends string | number | symbol>(
  obj: TObj,
  key: TKey
): TObj {
  const value = obj[key];
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete obj[key];
  (obj as Record<TKey, unknown>)[key] = value;
  return obj;
}

export function sortKeys<T extends Record<string, unknown>>(obj: T): T {
  const keyAndValues = Object.entries(obj).toSorted(([key1], [key2]) => key1.localeCompare(key2));
  for (const [key, value] of keyAndValues) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete obj[key];
    (obj as Record<string, unknown>)[key] = value;

    // if value is an object, sort the keys of the object
    if (typeof value === 'object' && value !== null) {
      sortKeys(value as Record<string, unknown>);
    }
  }
  return obj;
}
