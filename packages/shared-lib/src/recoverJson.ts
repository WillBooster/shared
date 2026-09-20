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
const QUOTES: Record<string, string> = { '"': '"', "'": "'", '“': '”', '‘': '’' };

/**
 * Extracts JSON values from a response, repairing common LLM syntax and retaining repair provenance.
 * Offsets refer to the original string. All candidates are returned: choosing among multiple answers,
 * schema validation, and provider truncation signals belong to the caller. No schema values are coerced.
 * Bounded to one million UTF-16 code units, 128 nesting levels, and 32 candidates.
 */
export function recoverJson(text: string): JsonRecovery {
  const result: JsonRecovery = { candidates: [], errors: [] };
  if (text.length > MAX_INPUT_LENGTH) {
    result.errors.push({ offset: MAX_INPUT_LENGTH, message: 'JSON recovery input exceeds one million characters' });
    return result;
  }
  const fences = [...text.matchAll(/^(?: {0,3})(`{3,}|~{3,})[^\n]*\n/gm)];
  if (fences.length > 0) {
    let consumed = 0;
    for (const fence of fences) {
      if (fence.index < consumed) continue;
      extractRegion(text, consumed, fence.index, result);
      const start = fence.index + fence[0].length;
      const marker = fence[1]!;
      const close = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`, 'gm');
      close.lastIndex = start;
      const match = close.exec(text);
      const end = match?.index ?? text.length;
      extractRegion(text, start, end, result);
      consumed = match === null ? text.length : match.index + match[0].length;
    }
    extractRegion(text, consumed, text.length, result);
  } else {
    extractRegion(text, 0, text.length, result);
  }
  return result;
}

function extractRegion(text: string, start: number, end: number, result: JsonRecovery): void {
  let index = start;
  while (index < end && /\s/.test(text[index]!)) index++;
  const first = text[index];
  const firstIndex = index;
  if (first === undefined) return;
  // Prose is not an unquoted root string: only structured starts are searched within prose.
  const rootValue =
    first in QUOTES || /[-\d]/.test(first) || /^(?:true|false|null)(?:\s|$)/.test(text.slice(index, end));
  while (index < end && result.candidates.length + result.errors.length < MAX_CANDIDATES) {
    if (!rootValue || index !== firstIndex) {
      while (index < end && text[index] !== '{' && text[index] !== '[') index++;
    }
    if (index >= end) break;
    const parser = new RecoveryParser(text, index, end);
    try {
      const json = parser.value(0);
      if (rootValue && index === firstIndex && text.slice(parser.index, end).trim() !== '') {
        index = parser.index;
        continue;
      }
      result.candidates.push({
        value: JSON.parse(json),
        json,
        start: index,
        end: parser.index,
        repairs: parser.repairs,
        requiresConfirmation: parser.repairs.some((repair) => repair.kind !== 'syntax'),
      });
    } catch (error) {
      result.errors.push({ offset: parser.index, message: error instanceof Error ? error.message : String(error) });
      return;
    }
    // Never reinterpret a nested member of a rejected document as its final answer.
    index = Math.max(index + 1, parser.index);
  }
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

  value(depth: number): string {
    if (depth > MAX_DEPTH) throw new Error('JSON nesting exceeds 128 levels');
    this.space();
    const char = this.text[this.index];
    if (this.index >= this.end || char === ',' || char === '}' || char === ']') {
      this.repair('incomplete', 'missing-value');
      return 'null';
    }
    if (char === '{' || char === '[') return this.container(depth, char === '{');
    if (char !== undefined && char in QUOTES) return this.string();
    const start = this.index;
    while (this.index < this.end && !/[\s,}\]:]/.test(this.text[this.index]!)) this.index++;
    if (this.index === start) throw new Error('Expected a JSON value');
    const token = this.text.slice(start, this.index);
    if (/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(token)) return token;
    const keywords: Record<string, string> = { True: 'true', False: 'false', None: 'null' };
    if (Object.hasOwn(keywords, token)) {
      this.repair('syntax', 'python-keyword', start);
      return keywords[token]!;
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
    for (;;) {
      this.space();
      if (this.index >= this.end || this.text[this.index] === close) {
        if (this.index >= this.end) this.repair('incomplete', `missing-${close}`);
        else this.index++;
        if (afterComma) this.repair('syntax', 'trailing-comma', this.index - 1);
        return (object ? '{' : '[') + items.join(',') + close;
      }
      if (this.text[this.index] === '}' || this.text[this.index] === ']') throw new Error('Mismatched closing bracket');
      if (this.text[this.index] === ',') {
        this.repair('ambiguous', 'extra-comma');
        this.index++;
        continue;
      }
      let key: string | undefined;
      if (object) {
        const start = this.index;
        if (this.text[this.index]! in QUOTES) key = this.string();
        else {
          while (this.index < this.end && !/[\s:,{}[\]]/.test(this.text[this.index]!)) this.index++;
          if (this.index === start) throw new Error('Expected an object key');
          key = JSON.stringify(this.text.slice(start, this.index));
          this.repair('syntax', 'unquoted-key', start);
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
      if (afterComma) this.index++;
      else if (this.index < this.end && this.text[this.index] !== close) this.repair('syntax', 'missing-comma');
    }
  }

  private string(): string {
    const start = this.index;
    const open = this.text[this.index++]!;
    const close = QUOTES[open];
    if (open !== '"') this.repair('syntax', 'non-json-quote', start);
    let value = '';
    while (this.index < this.end) {
      const char = this.text[this.index++]!;
      if (char === close) return JSON.stringify(value);
      if (char !== '\\') {
        if (char.codePointAt(0)! < 32) this.repair('syntax', 'unescaped-control-character', this.index - 1);
        value += char;
        continue;
      }
      const escapeOffset = this.index - 1;
      if (this.index >= this.end) {
        value += '\\';
        this.repair('incomplete', 'truncated-escape', escapeOffset);
        break;
      }
      const escape = this.text[this.index++]!;
      if (escape === 'u') {
        const hex = this.text.slice(this.index, Math.min(this.index + 4, this.end));
        if (/^[\da-fA-F]{4}$/.test(hex)) {
          value += String.fromCodePoint(Number.parseInt(hex, 16));
          this.index += 4;
        } else {
          value += String.raw`\u`;
          this.repair(this.index + 4 > this.end ? 'incomplete' : 'ambiguous', 'invalid-unicode-escape', escapeOffset);
        }
      } else if (String.raw`"\/bfnrt`.includes(escape)) {
        value += JSON.parse(`"\\${escape}"`) as string;
      } else if (escape === "'" && open === "'") value += "'";
      else {
        value += `\\${escape}`;
        this.repair('ambiguous', 'invalid-escape', escapeOffset);
      }
    }
    this.repair('incomplete', 'unterminated-string', start);
    return JSON.stringify(value);
  }

  private space(): void {
    while (this.index < this.end) {
      if (/\s/.test(this.text[this.index]!)) {
        if (!/[ \t\r\n]/.test(this.text[this.index]!)) this.repair('syntax', 'non-json-whitespace');
        this.index++;
      } else if (this.text.startsWith('//', this.index)) {
        this.repair('syntax', 'line-comment');
        while (this.index < this.end && this.text[this.index] !== '\n') this.index++;
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
}
