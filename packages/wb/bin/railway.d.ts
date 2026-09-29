export function railwayVariables<T>(
  preserve: () => T,
  railwayOnlyVariables?: Record<string, string>
): Record<string, T | string>;
