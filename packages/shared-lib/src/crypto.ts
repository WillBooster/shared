/**
 * Answers the SHA-256 hex digest of `data` (a string is encoded as UTF-8) with WebCrypto, so it runs in browsers and
 * Cloudflare Workers; the result equals Node.js's `createHash('sha256').update(data).digest('hex')`.
 */
export async function sha256HexAsync(data: string | Uint8Array): Promise<string> {
  // Copying into a fresh `ArrayBuffer` also accepts a `SharedArrayBuffer`-backed view, which WebCrypto rejects.
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Compares strings, e.g. a received API key against the expected one, with WebCrypto in time independent of their
 * lengths and of where they differ, so it runs in browsers and Cloudflare Workers.
 */
export async function timingSafeEqualStringAsync(actual: string, expected: string): Promise<boolean> {
  // Hashing gives equal-length inputs, so the loop below reveals neither length nor the first differing position.
  const [actualDigest, expectedDigest] = await Promise.all([digestCodeUnits(actual), digestCodeUnits(expected)]);
  let difference = 0;
  for (let i = 0; i < actualDigest.length; i++) {
    difference |= (actualDigest[i] ?? 0) ^ (expectedDigest[i] ?? 0);
  }
  return difference === 0;
}

async function digestCodeUnits(text: string): Promise<Uint8Array> {
  // UTF-16LE keeps every code unit, while UTF-8 would turn distinct lone surrogates into the same U+FFFD.
  const bytes = new DataView(new ArrayBuffer(text.length * 2));
  for (let i = 0; i < text.length; i++) {
    // oxlint-disable-next-line unicorn/prefer-code-point -- a code point would merge a surrogate pair into one value.
    bytes.setUint16(i * 2, text.charCodeAt(i), true);
  }
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}
