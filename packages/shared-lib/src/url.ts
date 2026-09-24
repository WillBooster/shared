export interface SafeRedirectPathOptions {
  /** Returned when `value` does not point to a page on `origin`. */
  fallback?: string;
  /** The app's own origin, e.g. `https://example.com`; absolute URLs on it are accepted and reduced to their paths. */
  origin?: string;
}

// A reserved domain (RFC 2606) that no absolute callback URL can legitimately point to.
const PLACEHOLDER_ORIGIN = 'https://redirect.invalid';

/**
 * Returns the path, query, and fragment of `value` when it points to a page on the app's own origin, and `fallback`
 * (`/` by default) otherwise, so that redirecting to a user-supplied callback URL cannot lead to another site.
 * `value` is resolved the way browsers resolve links, so `//evil.example`, `/\evil.example`, and `/\t/evil.example`
 * are rejected. For an array, such as a repeated query parameter, the first element is used.
 */
export function getSafeRedirectPath(
  value: string | readonly string[] | null | undefined,
  { fallback = '/', origin = PLACEHOLDER_ORIGIN }: SafeRedirectPathOptions = {}
): string {
  const rawValue = (typeof value === 'string' ? value : value?.[0])?.trim();
  if (!rawValue) return fallback;

  let url: URL;
  try {
    url = new URL(rawValue, origin);
  } catch {
    return fallback;
  }
  // Dot segments can leave a pathname such as `//evil.example`, which is protocol-relative once returned as a path.
  if (url.origin !== new URL(origin).origin || url.pathname.startsWith('//')) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}
