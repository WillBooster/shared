/**
 * Extracts the token from an `Authorization` header value of the Bearer scheme (RFC 6750), whose scheme name is
 * case-insensitive. Returns undefined for a missing header, another scheme, or a malformed value.
 */
export function parseBearerToken(authorization: string | null | undefined): string | undefined {
  if (!authorization) return undefined;
  // The scheme is compared after lowercasing instead of with the `i` flag, which together with `u` would let the token
  // class match non-ASCII case variants such as U+212A KELVIN SIGN for `k`.
  const match = /^(\S+) +([\w+./~-]+=*) *$/u.exec(authorization);
  return match?.[1]?.toLowerCase() === 'bearer' ? match[2] : undefined;
}

/** Returns a text field of `FormData`, or undefined when the field is missing or holds a file. */
export function getFormString(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === 'string' ? value : undefined;
}
