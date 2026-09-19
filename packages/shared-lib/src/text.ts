/** Escapes every RegExp metacharacter so the text matches itself literally. */
export function escapeRegExp(text: string): string {
  return text.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);
}

/** A POSIX shell word: safe characters pass through, anything else is single-quoted. */
export function quoteForShell(value: string): string {
  return /^[\w./-]+$/u.test(value) ? value : `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/**
 * Wraps text in a Markdown code block fenced with tildes, which are rarer than backticks in Markdown content.
 * The fence is longer than any run of tildes in the text so that the text cannot close it.
 */
export function toTildeCodeBlock(text: string, language = ''): string {
  let fence = '~~~';
  while (text.includes(fence)) fence += '~';
  return `${fence}${language}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}`;
}
