/**
 * Parses a decimal integer of at least 1 written without sign, whitespace, or leading zeros, e.g. a CLI option or an
 * environment variable. Returns undefined for any other input, including values beyond `Number.MAX_SAFE_INTEGER`.
 */
export function parsePositiveInteger(text: string): number | undefined {
  if (!/^[1-9]\d*$/u.test(text)) return undefined;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : undefined;
}
