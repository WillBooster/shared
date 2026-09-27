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
  return toFencedCodeBlock('~', text, language);
}

/**
 * Wraps text in a Markdown code block fenced with backticks.
 * The fence is longer than any run of backticks in the text so that the text cannot close it.
 */
export function toCodeBlock(text: string, language = ''): string {
  return toFencedCodeBlock('`', text, language);
}

function toFencedCodeBlock(fenceChar: string, text: string, language: string): string {
  const shortestFence = fenceChar.repeat(3);
  let longestRun = 2;
  let start = text.indexOf(shortestFence);
  while (start !== -1) {
    let end = start + 3;
    while (text[end] === fenceChar) end++;
    longestRun = Math.max(longestRun, end - start);
    start = text.indexOf(shortestFence, end);
  }
  let languageStart = 0;
  while (language[languageStart] === fenceChar) languageStart++;
  const fence = fenceChar.repeat(longestRun + 1 + languageStart);
  return `${fence}${language.slice(languageStart)}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}`;
}

/**
 * Shortens text to at most `maxLength` UTF-16 code units, including the `ellipsis` that marks the cut.
 * Throws a `RangeError` when `maxLength` cannot hold the ellipsis.
 */
export function truncate(text: string, maxLength: number, ellipsis = '…'): string {
  if (text.length <= maxLength) return text;
  if (maxLength < ellipsis.length) {
    throw new RangeError(`maxLength (${maxLength}) must be at least the ellipsis length (${ellipsis.length})`);
  }
  return `${sliceWithoutSplittingSurrogates(text, maxLength - ellipsis.length)}${ellipsis}`;
}

/**
 * Returns the first `end` code units of `text`, one fewer when the cut would split a surrogate pair,
 * because an unpaired surrogate is replaced with U+FFFD by encoders.
 */
export function sliceWithoutSplittingSurrogates(text: string, end: number): string {
  // A code point above U+FFFF starting at the last kept index is a pair whose low half would be cut off.
  return text.slice(0, (text.codePointAt(end - 1) ?? 0) > 0xFF_FF ? end - 1 : end);
}

const htmlSpecialCharacterPattern = /["&'<>]/u;

/** Escapes `&`, `<`, `>`, `"`, and `'`, so the result is safe in HTML text and in quoted attribute values. */
export function escapeHtml(text: string): string {
  // Scanning natively for the first special character keeps text without any as fast as a single regex test.
  const firstIndex = text.search(htmlSpecialCharacterPattern);
  if (firstIndex === -1) return text;
  let escaped = text.slice(0, firstIndex);
  let chunkStart = firstIndex;
  for (let index = firstIndex; index < text.length; index++) {
    let entity: string;
    switch (text.codePointAt(index)) {
      case 0x22: {
        entity = '&quot;';
        break;
      }
      case 0x26: {
        entity = '&amp;';
        break;
      }
      case 0x27: {
        entity = '&#39;';
        break;
      }
      case 0x3C: {
        entity = '&lt;';
        break;
      }
      case 0x3E: {
        entity = '&gt;';
        break;
      }
      default: {
        continue;
      }
    }
    escaped += text.slice(chunkStart, index) + entity;
    chunkStart = index + 1;
  }
  return escaped + text.slice(chunkStart);
}
