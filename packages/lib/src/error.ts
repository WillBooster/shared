export function ignoreError<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    // do nothing
  }
}
