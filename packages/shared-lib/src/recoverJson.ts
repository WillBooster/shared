/*! JSON recovery informed by jsonrepair, Copyright (c) 2020-2026 Jos de Jong (ISC). See NOTICE. */

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
  const fences = [...text.matchAll(/^(?: {0,3})(`{3,}|~{3,})[^\r\n]*(?:\r\n|[\r\n]|$)/gm)].flatMap((fence) => {
    const marker = fence[1]!;
    const markerEnd = fence.index + fence[0].indexOf(marker) + marker.length;
    const lineEnd = fence.index + fence[0].length;
    const info = text.slice(markerEnd, lineEnd);
    const inlinePrefix = /^[ \t]*json(?=[ \t{["'“”‘’])[ \t]*/i.exec(info);
    const inlineStart = inlinePrefix === null ? lineEnd : markerEnd + inlinePrefix[0].length;
    const start =
      text[inlineStart] === '{' || text[inlineStart] === '[' || scalarStart(text, inlineStart, lineEnd)
        ? inlineStart
        : lineEnd;
    return marker[0] === '`' && start === lineEnd && info.includes('`') ? [] : [{ index: fence.index, marker, start }];
  });
  if (fences.length > 0) {
    let consumed = 0;
    for (const fence of fences) {
      if (fence.index < consumed) continue;
      extractRegion(text, consumed, fence.index, result);
      const parsedThrough = result.candidates.at(-1)?.end ?? consumed;
      if (parsedThrough > fence.index) {
        consumed = parsedThrough;
        continue;
      }
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
          consumed = outerClose.index + outerClose[0].length;
          continue;
        }
      }
      consumed = Math.max(
        result.candidates.at(-1)?.end ?? start,
        match === null ? text.length : match.index + match[0].length
      );
    }
    extractRegion(text, consumed, text.length, result);
  } else {
    extractRegion(text, 0, text.length, result);
  }
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

function extractRegion(text: string, start: number, end: number, result: JsonRecovery, commentFragment = false): void {
  if (result.candidates.length >= MAX_CANDIDATES) return;
  let index = start;
  let failures = 0;
  let ambiguousScalarTail = false;
  let scalarBoundary = true;
  let uriBoundaryEnd = start;
  let uriTokenEnd = start;
  let uriContainerStart = start;
  while (index < end && /\s/.test(text[index]!)) index++;
  const firstIndex = index;
  const initialParser = new RecoveryParser(text, index, end);
  if (!commentFragment) initialParser.space();
  const initialValueStart = initialParser.index;
  if (initialValueStart >= end) {
    if (initialParser.repairs.some((repair) => repair.kind === 'incomplete') && result.errors.length < MAX_ERRORS)
      result.errors.push({ offset: index, message: 'Incomplete leading JSON comment' });
    return;
  }
  const first = text[initialValueStart];
  // Within prose, scalar starts need a line boundary; containers may appear inline.
  const rootValue = scalarStart(text, initialValueStart, end);
  const initialValue = rootValue || first === '{' || first === '[';
  if (!initialValue) index = initialValueStart;
  while (index < end && result.candidates.length < MAX_CANDIDATES && failures < MAX_ERRORS) {
    if (!initialValue || index !== firstIndex) {
      while (index < end && text[index] !== '{' && text[index] !== '[') {
        if (scalarBoundary && scalarStart(text, index, end)) break;
        const uriEnd =
          index === start || !/[\w+.-]/.test(text[index - 1]!) ? unquotedUriEnd(text, index, end) : undefined;
        if (uriEnd !== undefined) {
          if (index >= uriTokenEnd) {
            const whitespace = text.slice(index, end).search(/\s/);
            uriTokenEnd = whitespace === -1 ? end : index + whitespace;
            uriContainerStart = index;
          }
          if (index >= uriContainerStart) {
            const container = text.slice(index, uriTokenEnd).search(/[{[]/);
            uriContainerStart = container === -1 ? uriTokenEnd : index + container;
          }
          if (uriContainerStart < uriTokenEnd) uriBoundaryEnd = Math.max(uriBoundaryEnd, uriTokenEnd);
          index = Math.min(uriEnd, uriContainerStart);
          scalarBoundary = false;
          continue;
        }
        if (!commentFragment && text[index] === '/') {
          const trivia = new RecoveryParser(text, index, end);
          trivia.space();
          if (trivia.index > index) {
            if (trivia.repairs.some((repair) => repair.kind === 'incomplete') && result.errors.length < MAX_ERRORS)
              result.errors.push({ offset: index, message: 'Possibly unterminated comment-like span in prose' });
            extractRegion(text, index + 2, trivia.index, result, true);
            scalarBoundary ||= /[\r\n]/.test(text.slice(index, trivia.index));
            index = trivia.index;
            continue;
          }
        }
        if (/[\r\n]/.test(text[index]!)) scalarBoundary = true;
        else if (!/[\s,]/.test(text[index]!)) scalarBoundary = false;
        index++;
      }
    }
    if (index >= end || result.candidates.length >= MAX_CANDIDATES) break;
    let parser = initialValue && index === firstIndex ? initialParser : new RecoveryParser(text, index, end);
    const valueStart = parser.index;
    try {
      let json = parser.value(0);
      if (
        !commentFragment &&
        (text[valueStart] === '{' || text[valueStart] === '[') &&
        parser.index === end &&
        end < text.length
      ) {
        const extended = new RecoveryParser(text, index, text.length);
        try {
          const extendedJson = extended.value(0);
          if (
            extended.index > end &&
            extended.repairs.every((repair) => repair.reason === 'unescaped-control-character')
          ) {
            extended.repairs.push({ offset: end, kind: 'ambiguous', reason: 'literal-fence-in-string' });
            parser = extended;
            json = extendedJson;
          }
        } catch {
          // Keep the bounded interpretation when extending it is not a complete JSON document.
        }
      }
      const valueEnd = parser.index;
      if (text[valueStart] !== '{' && text[valueStart] !== '[' && !parser.finishScalar(end, valueStart)) {
        scalarBoundary = false;
        index = valueEnd;
        continue;
      }
      parser.space();
      if (
        text[valueStart]! in QUOTES &&
        parser.repairs.some((repair) => repair.reason === 'trailing-scalar-content') &&
        result.errors.length < MAX_ERRORS
      ) {
        const excerptEnd = Math.min(end, valueEnd + MAX_DIAGNOSTIC_EXCERPT);
        result.errors.push({
          offset: valueEnd,
          message: `Ambiguous quoted-scalar tail (${excerptEnd < end ? 'truncated excerpt' : 'excerpt'}): ${JSON.stringify(text.slice(valueEnd, excerptEnd))}`,
        });
      }
      if (commentFragment)
        parser.repairs.unshift({ offset: index, kind: 'ambiguous', reason: 'fragment-in-comment-like-prose' });
      if (failures > 0)
        parser.repairs.unshift({ offset: index, kind: 'ambiguous', reason: 'fragment-after-rejected-document' });
      if (ambiguousScalarTail)
        parser.repairs.unshift({ offset: index, kind: 'ambiguous', reason: 'fragment-after-ambiguous-scalar' });
      if (index < uriBoundaryEnd)
        parser.repairs.unshift({ offset: index, kind: 'ambiguous', reason: 'ambiguous-uri-boundary' });
      ambiguousScalarTail ||= parser.repairs.some((repair) => repair.reason === 'trailing-scalar-content');
      result.candidates.push({
        value: JSON.parse(json),
        json,
        start: index,
        end: parser.index,
        repairs: parser.repairs,
        requiresConfirmation: parser.repairs.some((repair) => repair.kind !== 'syntax'),
      });
    } catch (error) {
      if (result.errors.length < MAX_ERRORS)
        result.errors.push({ offset: parser.index, message: error instanceof Error ? error.message : String(error) });
      failures++;
      index = valueStart + 1;
      scalarBoundary = false;
      continue;
    }
    index = Math.max(index + 1, parser.index);
    scalarBoundary = true;
  }
}

function scalarStart(text: string, start: number, end: number): boolean {
  const first = text[start];
  if (first === undefined) return false;
  const keyword = /^([A-Za-z]+)/.exec(text.slice(start, end))?.[1];
  return first in QUOTES || /[-\d]/.test(first) || (keyword !== undefined && Object.hasOwn(KEYWORDS, keyword));
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
    const retainLiteral =
      this.text[start]! in QUOTES || this.repairs.some((repair) => repair.reason === 'unquoted-value');
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
    if (char === '{' || char === '[') {
      if (depth >= MAX_DEPTH) throw new Error('JSON nesting exceeds 128 levels');
      return this.container(depth, char === '{');
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

  private container(depth: number, object: boolean): string {
    this.index++;
    const close = object ? '}' : ']';
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
        return (object ? '{' : '[') + items.join(',') + close;
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
      let key: string | undefined;
      if (object) {
        const start = this.index;
        if (this.text[this.index]! in QUOTES) key = this.string();
        else {
          while (this.index < this.end && !/[\s:,{}[\]]/.test(this.text[this.index]!) && !this.comment()) this.index++;
          if (this.index === start) throw new Error('Expected an object key');
          const rawKey = this.text.slice(start, this.index);
          key = JSON.stringify(rawKey);
          this.repair(/["'“”‘’]/.test(rawKey) ? 'ambiguous' : 'syntax', 'unquoted-key', start);
        }
        const decoded: string = JSON.parse(key);
        if (keys.has(decoded)) this.repair('ambiguous', 'duplicate-key', start);
        keys.add(decoded);
        this.space();
        if (this.text[this.index] === ':') this.index++;
        else this.repair('ambiguous', 'missing-colon');
      }
      const value = this.value(depth + 1);
      items.push(key === undefined ? value : `${key}:${value}`);
      this.space();
      afterComma = this.text[this.index] === ',';
      if (afterComma) {
        commaOffset = this.index;
        this.index++;
      } else if (this.index < this.end && this.text[this.index] !== close) this.repair('syntax', 'missing-comma');
    }
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
        const after = this.text.slice(this.index, this.end).trimStart()[0];
        const delimited = after === undefined || /[,}\]:"']/.test(after);
        if (char === close) {
          if (embeddedQuote) {
            embeddedQuote = false;
            this.repair('ambiguous', 'unescaped-quote', this.index - 1);
            append(char);
            continue;
          }
          if (context !== 'root' && alternative !== undefined && !delimited) {
            this.index = alternative.end;
            this.repairs.length = alternative.repairCount;
            this.repair('ambiguous', 'mismatched-quote', this.index - 1);
            return JSON.stringify(alternative.value);
          }
          const nextClose = this.text.indexOf(close, this.index);
          const afterNext = this.text.slice(nextClose + 1, this.end).trimStart()[0];
          if (
            context === 'value' &&
            !delimited &&
            !/\s/.test(this.text[this.index] ?? '') &&
            nextClose > this.index &&
            nextClose < this.end &&
            afterNext !== undefined &&
            (!/[,}:\]]/.test(afterNext) ||
              (afterNext === ',' && this.continuesStringAfterComma(nextClose + 1, close))) &&
            !/[\\/*:,{}[\]\r\n]/.test(this.text.slice(this.index, nextClose)) &&
            !this.startsKey(nextClose)
          ) {
            embeddedQuote = true;
            this.repair('ambiguous', 'unescaped-quote', this.index - 1);
            append(char);
            continue;
          }
          return JSON.stringify(value);
        }
        if (delimited) alternative ??= { end: this.index, value, repairCount: this.repairs.length };
      }
      if (char !== '\\') {
        if (char.codePointAt(0)! < 32) this.repair('syntax', 'unescaped-control-character', this.index - 1);
        append(char);
        continue;
      }
      const escapeOffset = this.index - 1;
      if (this.index >= this.end) {
        append('\\');
        this.repair('incomplete', 'truncated-escape', escapeOffset);
        break;
      }
      const escape = this.text[this.index++]!;
      if (escape === 'u') {
        const hex = this.text.slice(this.index, Math.min(this.index + 4, this.end));
        if (/^[\da-fA-F]{4}$/.test(hex)) {
          append(String.fromCodePoint(Number.parseInt(hex, 16)));
          this.index += 4;
        } else {
          append(String.raw`\u`);
          this.repair(
            /^[\da-fA-F]{0,3}$/.test(hex) ? 'incomplete' : 'ambiguous',
            'invalid-unicode-escape',
            escapeOffset
          );
        }
      } else if (String.raw`"\/bfnrt`.includes(escape)) {
        append(JSON.parse(`"\\${escape}"`) as string);
      } else if (escape === "'" && open === "'") append("'");
      else {
        append(`\\${escape}`);
        this.repair('ambiguous', 'invalid-escape', escapeOffset);
      }
    }
    this.repair('incomplete', 'unterminated-string', start);
    return JSON.stringify(value);
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
    const after = this.text.slice(end + 1, this.end).trimStart()[0];
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
