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

/** Returns the tilde fence `toTildeCodeBlock` wraps `text` in: at least `~~~`, longer than any run of tildes in it. */
export function getTildeFence(text: string): string {
  return getFence('~', text);
}

function toFencedCodeBlock(fenceChar: string, text: string, language: string): string {
  let languageStart = 0;
  while (language[languageStart] === fenceChar) languageStart++;
  const fence = getFence(fenceChar, text) + fenceChar.repeat(languageStart);
  return `${fence}${language.slice(languageStart)}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}`;
}

function getFence(fenceChar: string, text: string): string {
  const shortestFence = fenceChar.repeat(3);
  let longestRun = 2;
  let start = text.indexOf(shortestFence);
  while (start !== -1) {
    let end = start + 3;
    while (text[end] === fenceChar) end++;
    longestRun = Math.max(longestRun, end - start);
    start = text.indexOf(shortestFence, end);
  }
  return fenceChar.repeat(longestRun + 1);
}

/**
 * Returns the document an LLM replied with inside the wrapper fence it was asked to keep, or `undefined` when the reply
 * is not wrapped as required so that the caller can retry. `fence` is the tilde fence the document was sent in, e.g.
 * `getTildeFence(document)`; this relies on it being longer than any run of tildes in the document.
 * A leading BOM is removed, CRLF is read as LF, and trailing whitespace is ignored on fence lines. Fences start at the
 * beginning of a line. The result is the lines strictly between the wrapper's fence lines joined with LF, untrimmed,
 * so a final newline of the document is not kept.
 * - Tilde wrapper: the first line starting with at least `fence.length` tildes, followed by any info string, opens it,
 *   and the last later line of only tildes, at least as many as the opening run, closes it. Text around it is dropped.
 * - Otherwise, backtick wrapper: the first nonblank line is a run of at least three backticks with no info string or
 *   one whose first word is `md` or `markdown` (case-insensitively), the last nonblank line is only backticks, at least
 *   as many, and no line between them starts with that many backticks.
 */
export function unwrapFencedReply(text: string, fence: string): string | undefined {
  if (fence.length < 3 || countLeading(fence, '~') !== fence.length) {
    throw new RangeError(`fence must be a run of at least three tildes: ${fence}`);
  }
  const lines = (text.startsWith('﻿') ? text.slice(1) : text).replaceAll('\r\n', '\n').split('\n');
  return unwrapTildeWrapper(lines, fence.length) ?? unwrapBacktickWrapper(lines);
}

function unwrapTildeWrapper(lines: readonly string[], minLength: number): string | undefined {
  const start = lines.findIndex((line) => countLeading(line, '~') >= minLength);
  if (start === -1) return;
  const openingLength = countLeading(lines[start] ?? '', '~');
  const end = lines.findLastIndex((line, index) => index > start && isFenceOnly(line, '~', openingLength));
  if (end === -1) return;
  return lines.slice(start + 1, end).join('\n');
}

function unwrapBacktickWrapper(lines: readonly string[]): string | undefined {
  const start = lines.findIndex((line) => line.trim() !== '');
  const end = lines.findLastIndex((line) => line.trim() !== '');
  if (start === end) return;
  const opening = lines[start] ?? '';
  const length = countLeading(opening, '`');
  if (length < 3 || !isMarkdownInfo(opening.slice(length)) || !isFenceOnly(lines[end] ?? '', '`', length)) return;
  const inner = lines.slice(start + 1, end);
  if (inner.some((line) => countLeading(line, '`') >= length)) return;
  return inner.join('\n');
}

function isMarkdownInfo(info: string): boolean {
  const trimmed = info.trim();
  let wordEnd = 0;
  while (wordEnd < trimmed.length && trimmed[wordEnd] !== ' ' && trimmed[wordEnd] !== '\t') wordEnd++;
  const word = trimmed.slice(0, wordEnd).toLowerCase();
  return word === '' || word === 'md' || word === 'markdown';
}

function isFenceOnly(line: string, fenceChar: string, minLength: number): boolean {
  const trimmed = line.trimEnd();
  return trimmed.length >= minLength && countLeading(trimmed, fenceChar) === trimmed.length;
}

function countLeading(line: string, char: string): number {
  let count = 0;
  while (line[count] === char) count++;
  return count;
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
 * Returns the first `end` code units of `text`, one fewer when the last kept unit is a high surrogate, whose low half
 * is either cut off or absent from `text`, because an unpaired surrogate is replaced with U+FFFD by encoders.
 */
export function sliceWithoutSplittingSurrogates(text: string, end: number): string {
  // oxlint-disable-next-line unicorn/prefer-code-point -- the check is on a single UTF-16 code unit
  const lastKeptUnit = text.charCodeAt(end - 1);
  return text.slice(0, lastKeptUnit >= 0xd8_00 && lastKeptUnit <= 0xdb_ff ? end - 1 : end);
}

const htmlEntities: Readonly<Record<string, string>> = {
  '"': '&quot;',
  '&': '&amp;',
  "'": '&#39;',
  '<': '&lt;',
  '>': '&gt;',
};

const htmlSpecialCharactersPattern = /["&'<>]/gu;

/** Escapes `&`, `<`, `>`, `"`, and `'`, so the result is safe in HTML text and in quoted attribute values. */
export function escapeHtml(text: string): string {
  // Measured in V8 and JavaScriptCore: a native `search` first is faster than `replaceAll` alone for text without these
  // characters, and one native `replaceAll` beats a per-code-unit loop for text where they are rare.
  return text.search(htmlSpecialCharactersPattern) === -1
    ? text
    : text.replaceAll(htmlSpecialCharactersPattern, (character) => htmlEntities[character] as string);
}
