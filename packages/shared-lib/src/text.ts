/** Escapes every RegExp metacharacter so the text matches itself literally. */
export function escapeRegExp(text: string): string {
  return text.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);
}

/** A POSIX shell word: safe characters pass through, anything else is single-quoted. */
export function quoteForShell(value: string): string {
  return /^[\w./-]+$/u.test(value) ? value : `'${value.replaceAll("'", String.raw`'\''`)}'`;
}
