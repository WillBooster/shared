export function railwayVariables<T, V = string>(
  preserve: () => T,
  railwayOnlyVariables?: Record<string, V>
): Record<string, T | V>;
