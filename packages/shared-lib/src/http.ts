/**
 * Extracts the token from an `Authorization` header value of the Bearer scheme (RFC 6750), whose scheme name is
 * case-insensitive. Returns undefined for a missing header, another scheme, or a malformed value.
 */
export function parseBearerToken(authorization: string | null | undefined): string | undefined {
  return authorization ? /^Bearer +([\w+./~-]+=*) *$/iu.exec(authorization)?.[1] : undefined;
}

/** Returns a text field of `FormData`, or undefined when the field is missing or holds a file. */
export function getFormString(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === 'string' ? value : undefined;
}
