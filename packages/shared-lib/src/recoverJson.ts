/*! JSON recovery informed by jsonrepair, Copyright (c) 2020-2026 Jos de Jong (ISC). See NOTICE. */

import { getErrorMessage } from './error.js';

export interface JsonRepair {
  /** UTF-16 offset in the original response. */
  offset: number;
  kind: 'syntax' | 'incomplete' | 'ambiguous';
  reason: string;
}

export interface RecoveredJson {
  value: unknown;
  json: string;
  start: number;
  end: number;
  repairs: JsonRepair[];
  /** Missing content or an ambiguous interpretation requires confirmation before acting on this value. */
  requiresConfirmation: boolean;
}

export interface JsonRecovery {
  candidates: RecoveredJson[];
  errors: { offset: number; message: string }[];
}

const MAX_INPUT_LENGTH = 1_000_000;
const MAX_DEPTH = 128;
const MAX_CANDIDATES = 32;
const MAX_ERRORS = 32;
const MAX_DIAGNOSTIC_EXCERPT = 256;
const QUOTES: Record<string, string> = { '"': '"', "'": "'", '“': '”', '”': '”', '‘': '’', '’': '’' };
const CLOSERS = { '{': '}', '[': ']' } as const;
const KEYWORDS: Record<string, string> = {
  true: 'true',
  false: 'false',
  null: 'null',
  True: 'true',
  False: 'false',
  None: 'null',
};

/**
 * Extracts JSON values from a response, repairing common LLM syntax and retaining repair provenance.
 * Offsets refer to the original string. All candidates are returned: choosing among multiple answers,
 * schema validation, and provider truncation signals belong to the caller. No schema values are coerced.
 * Bounded to one million UTF-16 code units, 128 nesting levels, and 32 candidates/errors each.
 * A region is abandoned after 32 failed starts; later Markdown regions can still yield candidates.
 */
export function recoverJson(text: string): JsonRecovery {
  const result: JsonRecovery = { candidates: [], errors: [] };
  if (text.length > MAX_INPUT_LENGTH) {
    result.errors.push({ offset: MAX_INPUT_LENGTH, message: 'JSON recovery input exceeds one million characters' });
    return result;
  }
  const fences = findFences(text);
  let consumed = 0;
  for (const fence of fences) {
    if (fence.index >= consumed) consumed = extractThroughFence(text, fences, fence, consumed, result);
  }
  extractRegion(text, consumed, text.length, result);
  if (result.candidates.length === MAX_CANDIDATES) {
    const error = {
      offset: result.candidates.at(-1)!.end,
      message: 'JSON candidate limit reached; extraction may be incomplete',
    };
    if (result.errors.length === MAX_ERRORS) result.errors[MAX_ERRORS - 1] = error;
    else result.errors.push(error);
  }
  return result;
}

interface Fence {
  index: number;
  marker: string;
  /** Where the fenced content starts: after the opening line, or within it when JSON follows the info string. */
  start: number;
}

function findFences(text: string): Fence[] {
  return [...text.matchAll(/^(?: {0,3})(`{3,}|~{3,})[^\r\n]*(?:\r\n|[\r\n]|$)/gm)].flatMap((fence) => {
    const marker = fence[1]!;
    const markerEnd = fence.index + fence[0].indexOf(marker) + marker.length;
    const lineEnd = fence.index + fence[0].length;
    const info = text.slice(markerEnd, lineEnd);
    const inlinePrefix = /^[ \t]*json(?=[ \t{["'“”‘’])[ \t]*/i.exec(info);
    const inlineStart = inlinePrefix === null ? lineEnd : markerEnd + inlinePrefix[0].length;
    const start =
      isContainerStart(text[inlineStart]) || scalarStart(text, inlineStart, lineEnd) ? inlineStart : lineEnd;
    return marker[0] === '`' && start === lineEnd && info.includes('`') ? [] : [{ index: fence.index, marker, start }];
  });
}

/** Extracts the prose before `fence` and then its content, returning the offset up to which the text is consumed. */
function extractThroughFence(
  text: string,
  fences: Fence[],
  fence: Fence,
  consumed: number,
  result: JsonRecovery
): number {
  extractRegion(text, consumed, fence.index, result);
  const parsedThrough = result.candidates.at(-1)?.end ?? consumed;
  if (parsedThrough > fence.index) return parsedThrough;
  const { marker, start } = fence;
  const close = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`, 'gm');
  close.lastIndex = start;
  const match = close.exec(text);
  const end = match?.index ?? text.length;
  extractRegion(text, start, end, result);
  const extendedEnd = result.candidates.at(-1)?.end ?? start;
  if (extendedEnd > end) {
    close.lastIndex = extendedEnd;
    const outerClose = close.exec(text);
    if (outerClose !== null && !fences.some((next) => next.index >= extendedEnd && next.index < outerClose.index)) {
      extractRegion(text, extendedEnd, outerClose.index, result);
      return outerClose.index + outerClose[0].length;
    }
  }
  return Math.max(result.candidates.at(-1)?.end ?? start, match === null ? text.length : match.index + match[0].length);
}

function extractRegion(text: string, start: number, end: number, result: JsonRecovery, commentFragment = false): void {
  if (result.candidates.length < MAX_CANDIDATES) new RegionExtractor(text, start, end, result, commentFragment).run();
}

class RegionExtractor {
  private readonly text: string;
  private readonly start: number;
  private readonly end: number;
  private readonly result: JsonRecovery;
  private readonly commentFragment: boolean;
  private index: number;
  private failures = 0;
  private ambiguousScalarTail = false;
  private scalarBoundary = true;
  private uriBoundaryEnd: number;
  private uriTokenEnd: number;
  private uriContainerStart: number;

  constructor(text: string, start: number, end: number, result: JsonRecovery, commentFragment: boolean) {
    this.text = text;
    this.start = start;
    this.end = end;
    this.result = result;
    this.commentFragment = commentFragment;
    this.index = start;
    this.uriBoundaryEnd = start;
    this.uriTokenEnd = start;
    this.uriContainerStart = start;
  }

  run(): void {
    const { text, end, result } = this;
    while (this.index < end && /\s/.test(text[this.index]!)) this.index++;
    const firstIndex = this.index;
    const initialParser = new RecoveryParser(text, this.index, end);
    if (!this.commentFragment) initialParser.space();
    const initialValueStart = initialParser.index;
    if (initialValueStart >= end) {
      if (initialParser.repairs.some((repair) => repair.kind === 'incomplete'))
        this.reportError(this.index, 'Incomplete leading JSON comment');
      return;
    }
    // Within prose, scalar starts need a line boundary; containers may appear inline.
    const initialValue = scalarStart(text, initialValueStart, end) || isContainerStart(text[initialValueStart]);
    if (!initialValue) this.index = initialValueStart;
    while (this.index < end && result.candidates.length < MAX_CANDIDATES && this.failures < MAX_ERRORS) {
      const atInitialValue = initialValue && this.index === firstIndex;
      if (!atInitialValue) this.skipProse();
      if (this.index >= end || result.candidates.length >= MAX_CANDIDATES) break;
      this.extractCandidate(atInitialValue ? initialParser : new RecoveryParser(text, this.index, end));
    }
  }

  /** Advances to the next position where a JSON value may start. */
  private skipProse(): void {
    const { text, end } = this;
    while (this.index < end && !isContainerStart(text[this.index])) {
      if (this.scalarBoundary && scalarStart(text, this.index, end)) break;
      if (this.skipUri() || this.skipCommentLikeSpan()) continue;
      if (/[\r\n]/.test(text[this.index]!)) this.scalarBoundary = true;
      else if (!/[\s,]/.test(text[this.index]!)) this.scalarBoundary = false;
      this.index++;
    }
  }

  private skipUri(): boolean {
    const { text, end, index } = this;
    if (index !== this.start && /[\w+.-]/.test(text[index - 1]!)) return false;
    const uriEnd = unquotedUriEnd(text, index, end);
    if (uriEnd === undefined) return false;
    if (index >= this.uriTokenEnd) {
      const whitespace = text.slice(index, end).search(/\s/);
      this.uriTokenEnd = whitespace === -1 ? end : index + whitespace;
      this.uriContainerStart = index;
    }
    if (index >= this.uriContainerStart) {
      const container = text.slice(index, this.uriTokenEnd).search(/[{[]/);
      this.uriContainerStart = container === -1 ? this.uriTokenEnd : index + container;
    }
    if (this.uriContainerStart < this.uriTokenEnd)
      this.uriBoundaryEnd = Math.max(this.uriBoundaryEnd, this.uriTokenEnd);
    this.index = Math.min(uriEnd, this.uriContainerStart);
    this.scalarBoundary = false;
    return true;
  }

  private skipCommentLikeSpan(): boolean {
    const { text, end, index } = this;
    if (this.commentFragment || text[index] !== '/') return false;
    const trivia = new RecoveryParser(text, index, end);
    trivia.space();
    if (trivia.index <= index) return false;
    if (trivia.repairs.some((repair) => repair.kind === 'incomplete'))
      this.reportError(index, 'Possibly unterminated comment-like span in prose');
    extractRegion(text, index + 2, trivia.index, this.result, true);
    this.scalarBoundary ||= /[\r\n]/.test(text.slice(index, trivia.index));
    this.index = trivia.index;
    return true;
  }

  private extractCandidate(bounded: RecoveryParser): void {
    const { text, end, index } = this;
    const valueStart = bounded.index;
    let parser = bounded;
    try {
      const boundedJson = bounded.value(0);
      const extended = this.parsePastRegionEnd(bounded, valueStart);
      parser = extended?.parser ?? bounded;
      const json = extended?.json ?? boundedJson;
      const valueEnd = parser.index;
      if (!isContainerStart(text[valueStart]) && !parser.finishScalar(end, valueStart)) {
        this.scalarBoundary = false;
        this.index = valueEnd;
        return;
      }
      parser.space();
      this.consumeSurplusClosers(parser);
      if (text[valueStart]! in QUOTES && parser.hasRepair('trailing-scalar-content'))
        this.reportExcerpt(valueEnd, 'Ambiguous quoted-scalar tail');
      this.markFragmentProvenance(parser);
      this.ambiguousScalarTail ||= parser.hasRepair('trailing-scalar-content');
      this.result.candidates.push({
        value: JSON.parse(json),
        json,
        start: index,
        end: parser.index,
        repairs: parser.repairs,
        requiresConfirmation: parser.repairs.some((repair) => repair.kind !== 'syntax'),
      });
    } catch (error) {
      this.reportError(parser.index, getErrorMessage(error));
      this.failures++;
      this.index = valueStart + 1;
      this.scalarBoundary = false;
      return;
    }
    this.index = Math.max(index + 1, parser.index);
    this.scalarBoundary = true;
  }

  /**
   * Reparses a container that `bounded` ended exactly at the region end against the rest of the text,
   * as the fence that bounds the region may be literal text inside one of its strings.
   */
  private parsePastRegionEnd(
    bounded: RecoveryParser,
    valueStart: number
  ): { parser: RecoveryParser; json: string } | undefined {
    const { text, end } = this;
    if (this.commentFragment || !isContainerStart(text[valueStart]) || bounded.index !== end || end >= text.length)
      return undefined;
    const parser = new RecoveryParser(text, this.index, text.length);
    try {
      const json = parser.value(0);
      if (parser.index > end && parser.repairs.every((repair) => repair.reason === 'unescaped-control-character')) {
        parser.repairs.push({ offset: end, kind: 'ambiguous', reason: 'literal-fence-in-string' });
        return { parser, json };
      }
    } catch {
      // Keep the bounded interpretation when extending it is not a complete JSON document.
    }
    return undefined;
  }

  private consumeSurplusClosers(parser: RecoveryParser): void {
    if (this.commentFragment || this.failures > 0) return;
    const surplusStart = parser.index;
    while (parser.index < this.end && /[}\]]/.test(this.text[parser.index]!)) {
      parser.repairs.push({ offset: parser.index, kind: 'ambiguous', reason: 'surplus-closing-bracket' });
      parser.index++;
      parser.space();
    }
    if (parser.index > surplusStart)
      this.reportExcerpt(surplusStart, 'Surplus closing brackets and possible continuation');
  }

  private markFragmentProvenance(parser: RecoveryParser): void {
    const mark = (reason: string): void => {
      parser.repairs.unshift({ offset: this.index, kind: 'ambiguous', reason });
    };
    if (this.commentFragment) mark('fragment-in-comment-like-prose');
    if (this.failures > 0) mark('fragment-after-rejected-document');
    if (this.ambiguousScalarTail) mark('fragment-after-ambiguous-scalar');
    if (this.index < this.uriBoundaryEnd) mark('ambiguous-uri-boundary');
  }

  private reportExcerpt(offset: number, summary: string): void {
    const excerptEnd = Math.min(this.end, offset + MAX_DIAGNOSTIC_EXCERPT);
    const excerpt = JSON.stringify(this.text.slice(offset, excerptEnd));
    this.reportError(offset, `${summary} (${excerptEnd < this.end ? 'truncated excerpt' : 'excerpt'}): ${excerpt}`);
  }

  private reportError(offset: number, message: string): void {
    if (this.result.errors.length < MAX_ERRORS) this.result.errors.push({ offset, message });
  }
}

function isContainerStart(char: string | undefined): char is keyof typeof CLOSERS {
  return char === '{' || char === '[';
}

function scalarStart(text: string, start: number, end: number): boolean {
  const first = text[start];
  if (first === undefined) return false;
  const keyword = /^([A-Za-z]+)/.exec(text.slice(start, end))?.[1];
  return (
    first in QUOTES ||
    /[-\d]/.test(first) ||
    (keyword !== undefined &&
      (Object.hasOwn(KEYWORDS, keyword) ||
        (Object.keys(KEYWORDS).some((word) => word.startsWith(keyword)) &&
          /^[^\S\r\n]*(?:[\r\n]|$)/.test(text.slice(start + keyword.length, end)))))
  );
}

class RecoveryParser {
  readonly repairs: JsonRepair[] = [];
  readonly text: string;
  readonly end: number;
  index: number;

  constructor(text: string, index: number, end: number) {
    this.text = text;
    this.index = index;
    this.end = end;
  }

  finishScalar(regionEnd: number, start: number): boolean {
    const valueEnd = this.index;
    const atom = this.text.slice(start, valueEnd);
    const bullet = atom === '-' && /\s/.test(this.text[valueEnd] ?? '');
    const retainLiteral = this.text[start]! in QUOTES || this.hasRepair('unquoted-value');
    this.space();
    if (bullet) return false;
    if (this.index >= regionEnd) return true;
    if (/[\r\n]/.test(this.text.slice(valueEnd, this.index))) {
      this.repair('ambiguous', 'scalar-before-prose', valueEnd);
      return true;
    }
    if (/^\d+[.)]$/.test(atom) && /[ \t]/.test(this.text[valueEnd] ?? '')) return false;
    if (retainLiteral || /^[\p{P}\p{S}]/u.test(this.text.slice(this.index, regionEnd))) {
      this.repair('ambiguous', 'trailing-scalar-content', valueEnd);
      return true;
    }
    return false;
  }

  value(depth: number): string {
    if (depth > MAX_DEPTH) throw new Error('JSON nesting exceeds 128 levels');
    this.space();
    const char = this.text[this.index];
    if (this.index >= this.end || char === ',' || char === '}' || char === ']') {
      this.repair('incomplete', 'missing-value');
      return 'null';
    }
    if (isContainerStart(char)) {
      if (depth >= MAX_DEPTH) throw new Error('JSON nesting exceeds 128 levels');
      return this.container(depth, char);
    }
    if (char !== undefined && char in QUOTES) return this.string(depth > 0 ? 'value' : 'root');
    const start = this.index;
    const uriEnd = unquotedUriEnd(this.text, start, this.end);
    if (uriEnd !== undefined) this.index = uriEnd;
    else
      while (
        this.index < this.end &&
        !/[\s,}\]]/.test(this.text[this.index]!) &&
        !(depth === 0 && /[{[]/.test(this.text[this.index]!)) &&
        !this.comment()
      )
        this.index++;
    if (this.index === start) throw new Error('Expected a JSON value');
    const token = this.text.slice(start, this.index);
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)) return token;
    if (Object.hasOwn(KEYWORDS, token)) {
      const canonical = KEYWORDS[token]!;
      if (canonical !== token) this.repair('syntax', 'python-keyword', start);
      return canonical;
    }
    this.repair(this.index >= this.end ? 'incomplete' : 'ambiguous', 'unquoted-value', start);
    return JSON.stringify(token);
  }

  private container(depth: number, open: keyof typeof CLOSERS): string {
    this.index++;
    const object = open === '{';
    const close = CLOSERS[open];
    const items: string[] = [];
    const keys = new Set<string>();
    let afterComma = false;
    let commaOffset = this.index;
    for (;;) {
      this.space();
      if (this.index >= this.end || this.text[this.index] === close) {
        if (this.index >= this.end) this.repair('incomplete', `missing-${close}`);
        else this.index++;
        if (afterComma) this.repair('syntax', 'trailing-comma', commaOffset);
        return open + items.join(',') + close;
      }
      if (this.text[this.index] === '}' || this.text[this.index] === ']') throw new Error('Mismatched closing bracket');
      if (this.text[this.index] === ',') {
        if (object) this.repair('ambiguous', 'extra-comma');
        else {
          items.push('null');
          this.repair('incomplete', 'missing-value');
        }
        commaOffset = this.index;
        afterComma = true;
        this.index++;
        continue;
      }
      items.push(object ? `${this.key(keys)}:${this.value(depth + 1)}` : this.value(depth + 1));
      this.space();
      afterComma = this.text[this.index] === ',';
      if (afterComma) {
        commaOffset = this.index;
        this.index++;
      } else if (this.index < this.end && this.text[this.index] !== close) this.repair('syntax', 'missing-comma');
    }
  }

  /** Parses an object key and the colon after it, returning the key as JSON. */
  private key(seen: Set<string>): string {
    const start = this.index;
    const key = this.text[start]! in QUOTES ? this.string() : this.unquotedKey();
    const decoded: string = JSON.parse(key);
    if (seen.has(decoded)) this.repair('ambiguous', 'duplicate-key', start);
    seen.add(decoded);
    this.space();
    if (this.text[this.index] === ':') this.index++;
    else this.repair('ambiguous', 'missing-colon');
    return key;
  }

  private unquotedKey(): string {
    const start = this.index;
    while (this.index < this.end && !/[\s:,{}[\]]/.test(this.text[this.index]!) && !this.comment()) this.index++;
    if (this.index === start) throw new Error('Expected an object key');
    const rawKey = this.text.slice(start, this.index);
    this.repair(/["'“”‘’]/.test(rawKey) ? 'ambiguous' : 'syntax', 'unquoted-key', start);
    return JSON.stringify(rawKey);
  }

  private string(context: 'root' | 'key' | 'value' = 'key'): string {
    const start = this.index;
    const open = this.text[this.index++]!;
    const close = QUOTES[open]!;
    if (open !== '"') this.repair('syntax', 'non-json-quote', start);
    let value = '';
    let tail = '';
    const append = (text: string): void => {
      value += text;
      tail = (tail + text).slice(-2);
    };
    let embeddedQuote = false;
    const family = '"“”'.includes(open) ? '"“”' : "'‘’";
    let alternative: { end: number; value: string; repairCount: number } | undefined;
    while (this.index < this.end) {
      const char = this.text[this.index++]!;
      if (
        "'‘’".includes(open) &&
        "'’".includes(char) &&
        /[\p{L}\p{N}]$/u.test(tail) &&
        /^[\p{L}\p{N}]/u.test(this.text.slice(this.index, this.end))
      ) {
        this.repair('ambiguous', 'literal-apostrophe', this.index - 1);
        append(char);
        continue;
      }
      if (family.includes(char)) {
        const after = this.charAfterSpace(this.index);
        const delimited = after === undefined || /[,}\]:"']/.test(after);
        if (char !== close) {
          if (delimited) alternative ??= { end: this.index, value, repairCount: this.repairs.length };
        } else if (!embeddedQuote && context !== 'root' && alternative !== undefined && !delimited) {
          this.index = alternative.end;
          this.repairs.length = alternative.repairCount;
          this.repair('ambiguous', 'mismatched-quote', this.index - 1);
          return JSON.stringify(alternative.value);
        } else if (embeddedQuote || (context === 'value' && !delimited && this.opensEmbeddedQuote(close))) {
          embeddedQuote = !embeddedQuote;
          this.repair('ambiguous', 'unescaped-quote', this.index - 1);
        } else return JSON.stringify(value);
      }
      if (char === '\\') append(this.escapeSequence(open));
      else {
        if (char.codePointAt(0)! < 32) this.repair('syntax', 'unescaped-control-character', this.index - 1);
        append(char);
      }
    }
    this.repair('incomplete', 'unterminated-string', start);
    return JSON.stringify(value);
  }

  /** Whether the closing quote just consumed and the next one more plausibly enclose a phrase quoted within the string. */
  private opensEmbeddedQuote(close: string): boolean {
    const nextClose = this.text.indexOf(close, this.index);
    const afterNext = this.charAfterSpace(nextClose + 1);
    return (
      !/\s/.test(this.text[this.index] ?? '') &&
      nextClose > this.index &&
      nextClose < this.end &&
      afterNext !== undefined &&
      (!/[,}:\]]/.test(afterNext) || (afterNext === ',' && this.continuesStringAfterComma(nextClose + 1, close))) &&
      !/[\\*:,{}[\]\r\n]|\/\//.test(this.text.slice(this.index, nextClose)) &&
      !this.startsKey(nextClose)
    );
  }

  /** Decodes the escape sequence whose backslash was just consumed. */
  private escapeSequence(open: string): string {
    const escapeOffset = this.index - 1;
    if (this.index >= this.end) {
      this.repair('incomplete', 'truncated-escape', escapeOffset);
      return '\\';
    }
    const escape = this.text[this.index++]!;
    if (escape === 'u') {
      const hex = this.text.slice(this.index, Math.min(this.index + 4, this.end));
      if (/^[\da-fA-F]{4}$/.test(hex)) {
        this.index += 4;
        return String.fromCodePoint(Number.parseInt(hex, 16));
      }
      this.repair(/^[\da-fA-F]{0,3}$/.test(hex) ? 'incomplete' : 'ambiguous', 'invalid-unicode-escape', escapeOffset);
      return String.raw`\u`;
    }
    if (String.raw`"\/bfnrt`.includes(escape)) return JSON.parse(`"\\${escape}"`) as string;
    if (escape === "'" && open === "'") return "'";
    this.repair('ambiguous', 'invalid-escape', escapeOffset);
    return `\\${escape}`;
  }

  private continuesStringAfterComma(start: number, quote: string): boolean {
    const parser = new RecoveryParser(this.text, start - 1, this.end);
    parser.string();
    const end = parser.index - 1;
    if (
      this.text[end] !== quote ||
      parser.repairs.some(
        (repair) => !['non-json-quote', 'literal-apostrophe', 'unescaped-control-character'].includes(repair.reason)
      )
    )
      return false;
    const continuation = this.text.slice(start, end);
    const after = this.charAfterSpace(end + 1);
    return (
      /^\s*,\s*[\p{L}\p{N}]/u.test(continuation) &&
      !/[\\:{}[\]]/.test(continuation) &&
      (after === undefined || /[,}\]]/.test(after))
    );
  }

  private startsKey(index: number): boolean {
    const parser = new RecoveryParser(this.text, index, this.end);
    parser.string();
    parser.space();
    return this.text[parser.index] === ':';
  }

  space(): void {
    while (this.index < this.end) {
      if (/\s/.test(this.text[this.index]!)) {
        if (!/[ \t\r\n]/.test(this.text[this.index]!)) this.repair('syntax', 'non-json-whitespace');
        this.index++;
      } else if (this.text.startsWith('//', this.index)) {
        this.repair('syntax', 'line-comment');
        while (this.index < this.end && !/[\r\n]/.test(this.text[this.index]!)) this.index++;
      } else if (this.text.startsWith('/*', this.index)) {
        const end = this.text.indexOf('*/', this.index + 2);
        this.repair(end === -1 || end >= this.end ? 'incomplete' : 'syntax', 'block-comment');
        this.index = end === -1 || end >= this.end ? this.end : end + 2;
      } else break;
    }
  }

  hasRepair(reason: string): boolean {
    return this.repairs.some((repair) => repair.reason === reason);
  }

  private charAfterSpace(index: number): string | undefined {
    return this.text.slice(index, this.end).trimStart()[0];
  }

  private repair(kind: JsonRepair['kind'], reason: string, offset = this.index): void {
    this.repairs.push({ offset, kind, reason });
  }

  private comment(): boolean {
    return this.text.startsWith('//', this.index) || this.text.startsWith('/*', this.index);
  }
}

function unquotedUriEnd(text: string, start: number, end: number): number | undefined {
  const match = /^[A-Za-z][A-Za-z\d+.-]*:\/\//.exec(text.slice(start, end));
  if (match === null) return;
  let index = start + match[0].length;
  let brackets = 0;
  while (index < end && !/[\s}]/.test(text[index]!)) {
    if (text[index] === ',' && brackets === 0) break;
    if (text[index] === '[') brackets++;
    else if (text[index] === ']') {
      if (brackets === 0) break;
      brackets--;
    }
    index++;
  }
  return index;
}
