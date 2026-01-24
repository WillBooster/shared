export function ensureTruthy<T>(name: string, value: T): NonNullable<T> {
  if (!value) {
    throw new Error(`The value of "${name}" must be truthy.`);
  }
  return value;
}
