import { createHash, timingSafeEqual } from 'node:crypto';

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Compares strings, e.g. a received API key against the expected one, in time independent of where they differ.
 * Both are hashed first because `timingSafeEqual` requires equal lengths, and an early length check would reveal the
 * secret's length.
 */
export function timingSafeEqualString(actual: string, expected: string): boolean {
  return timingSafeEqual(digestCodeUnits(actual), digestCodeUnits(expected));
}

function digestCodeUnits(text: string): Buffer {
  // UTF-16LE keeps every code unit, while UTF-8 would turn distinct lone surrogates into the same U+FFFD.
  return createHash('sha256').update(text, 'utf16le').digest();
}
