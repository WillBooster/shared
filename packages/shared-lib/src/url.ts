export interface SafeRedirectPathOptions {
  /** The app's own origin, e.g. `https://example.com`; an unparsable origin throws a `TypeError`. */
  origin: string;
  /** Returned when `value` does not point to a page on `origin`. */
  fallback?: string;
}

/**
 * Returns the path, query, and fragment of `value` when it points to a page on the app's own origin, and `fallback`
 * (`/` by default) otherwise, so that redirecting to a user-supplied callback URL cannot lead to another site.
 * `value` is resolved against `origin` the way browsers resolve links, so relative paths and absolute URLs on
 * `origin` are accepted, while `//evil.example`, `/\evil.example`, and `/\t/evil.example` are rejected. For an array,
 * such as a repeated query parameter, the first element is used.
 */
export function getSafeRedirectPath(
  value: string | readonly string[] | null | undefined,
  { origin, fallback = '/' }: SafeRedirectPathOptions
): string {
  // Parsed outside the per-value `try` so that a misconfigured origin fails loudly instead of rejecting every value.
  const baseUrl = new URL(origin);
  const rawValue = (typeof value === 'string' ? value : value?.[0])?.trim();
  if (!rawValue) return fallback;

  let url: URL;
  try {
    url = new URL(rawValue, baseUrl);
  } catch {
    return fallback;
  }
  // A `blob:` URL shares its inner URL's origin but has that URL as its pathname, hence the protocol check.
  // Dot segments can leave a pathname such as `//evil.example`, which is protocol-relative once returned as a path.
  if (url.protocol !== baseUrl.protocol || url.origin !== baseUrl.origin || url.pathname.startsWith('//')) {
    return fallback;
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
