import { toTildeCodeBlock } from './text.js';

const INDENT_STEP = '  ';
const MAX_IMPLICIT_KEY_LENGTH = 1024;
const MIN_MULTI_LINE_DOUBLE_QUOTED_LENGTH = 40;

/** Strings matching this would be read back as a non-string scalar (null, bool, int, or float), so they must be quoted. */
const NON_STRING_SCALAR =
  /^(?:~|[Nn]ull|NULL|[Tt]rue|TRUE|[Ff]alse|FALSE|0o[0-7]+|[-+]?[0-9]+|0x[0-9a-fA-F]+|[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN|[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+|[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*))?$/u;

// A single-line string must be quoted if it matches any of these. Checking the start, the middle, and the end separately
// is much faster on long strings than one regex whose anchored alternatives are retried at every position.
const UNSAFE_PLAIN_START = /^(?:[\t ,[\]{}#&*!|>'"%@`]|[?-](?:[ \t]|$))/u;
const UNSAFE_PLAIN_MIDDLE = /:[ \t]|[ \t]#/u;
const UNSAFE_PLAIN_END = /[\t :]$/u;

const SHORT_UNICODE_ESCAPES: Record<string, string> = {
  '0000': String.raw`\0`,
  '0007': String.raw`\a`,
  '000b': String.raw`\v`,
  '001b': String.raw`\e`,
};

interface Context {
  indent: string;
  implicitKey?: boolean;
  forceBlockIndent?: boolean;
}

/**
 * Serializes plain JSON data (objects, arrays, strings, numbers, booleans, and null, honoring `toJSON` such as that of `Date`)
 * into a code block to embed in an LLM prompt.
 * The format inside the code block is an implementation detail and may change.
 */
export function serializeForPrompt(value: unknown): string {
  return toTildeCodeBlock(`${stringifyValue(toJsonValue(value), { indent: '' })}\n`, 'yaml');
}

// The functions below reproduce `stringify(value, { lineWidth: 0, aliasDuplicateObjects: false, blockQuote: 'literal' })`
// of the `yaml` package, restricted to JSON-compatible values.

function toJsonValue(value: unknown): unknown {
  return typeof (value as { toJSON?: unknown } | null | undefined)?.toJSON === 'function'
    ? (value as { toJSON: () => unknown }).toJSON()
    : value;
}

function stringifyValue(value: unknown, ctx: Context): string {
  switch (typeof value) {
    case 'undefined': {
      return 'null';
    }
    case 'boolean': {
      return String(value);
    }
    case 'number': {
      return stringifyNumber(value);
    }
    case 'string': {
      return stringifyString(value, ctx);
    }
    case 'object': {
      if (value === null) return 'null';
      const separator = `\n${ctx.indent}`;
      let str = '';
      if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        const itemCtx = { indent: ctx.indent + INDENT_STEP };
        for (const item of value as unknown[]) {
          str += `${str ? separator : ''}- ${stringifyValue(toJsonValue(item), itemCtx)}`;
        }
        return str;
      }
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        const item = record[key];
        if (item !== undefined) str += `${str ? separator : ''}${stringifyPair(key, toJsonValue(item), ctx)}`;
      }
      return str || '{}';
    }
    default: {
      throw new TypeError(`Cannot serialize a ${typeof value} value for a prompt`);
    }
  }
}

function stringifyPair(key: string, value: unknown, ctx: Context): string {
  const indent = ctx.indent + INDENT_STEP;
  const keyStr = stringifyString(key, { indent, implicitKey: true });
  const valueStr = stringifyValue(value, { indent });
  if (keyStr.length > MAX_IMPLICIT_KEY_LENGTH) return `? ${keyStr}\n${ctx.indent}: ${valueStr}`;
  const isBlockCollection = typeof value === 'object' && value !== null && valueStr !== '[]' && valueStr !== '{}';
  return `${keyStr}:${isBlockCollection ? `\n${indent}` : ' '}${valueStr}`;
}

function stringifyNumber(value: number): string {
  if (Number.isNaN(value)) return '.nan';
  if (!Number.isFinite(value)) return value < 0 ? '-.inf' : '.inf';
  return Object.is(value, -0) ? '-0' : JSON.stringify(value);
}

function stringifyString(value: string, ctx: Context): string {
  // oxlint-disable-next-line no-control-regex -- control characters and lone surrogates can only be written escaped.
  return /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u{D800}-\u{DFFF}]/u.test(value)
    ? doubleQuotedString(value, ctx)
    : plainString(value, ctx);
}

function plainString(value: string, ctx: Context): string {
  const { implicitKey, indent } = ctx;
  if (value.includes('\n')) return implicitKey ? quotedString(value, ctx) : blockString(value, ctx);
  if (UNSAFE_PLAIN_START.test(value) || UNSAFE_PLAIN_END.test(value.slice(-1)) || UNSAFE_PLAIN_MIDDLE.test(value)) {
    return quotedString(value, ctx);
  }
  if (containsDocumentMarker(value)) {
    if (indent === '') return blockString(value, { ...ctx, forceBlockIndent: true });
    if (implicitKey && indent === INDENT_STEP) return quotedString(value, ctx);
  }
  return NON_STRING_SCALAR.test(value) ? quotedString(value, ctx) : value;
}

function containsDocumentMarker(value: string): boolean {
  return /^(?:%|---|\.\.\.)/mu.test(value);
}

function quotedString(value: string, ctx: Context): string {
  return value.includes('"') && !value.includes("'") ? singleQuotedString(value, ctx) : doubleQuotedString(value, ctx);
}

function singleQuotedString(value: string, ctx: Context): string {
  if ((ctx.implicitKey && value.includes('\n')) || /[ \t]\n|\n[ \t]/u.test(value)) {
    return doubleQuotedString(value, ctx);
  }
  const indent = ctx.indent || (containsDocumentMarker(value) ? INDENT_STEP : '');
  return `'${value.replaceAll("'", "''").replaceAll(/\n+/gu, `$&\n${indent}`)}'`;
}

function doubleQuotedString(value: string, ctx: Context): string {
  const json = JSON.stringify(value);
  const indent = ctx.indent || (containsDocumentMarker(value) ? INDENT_STEP : '');
  let str = '';
  let start = 0;
  for (let i = 0; i < json.length; i++) {
    let ch = json[i];
    if (ch === ' ' && json[i + 1] === '\\' && json[i + 2] === 'n') {
      // A space before a line break would be folded away unless escaped.
      str += `${json.slice(start, i)}\\ `;
      i++;
      start = i;
      ch = '\\';
    }
    if (ch !== '\\') continue;
    if (json[i + 1] === 'u') {
      const code = json.slice(i + 2, i + 6);
      str +=
        json.slice(start, i) +
        (SHORT_UNICODE_ESCAPES[code] ?? (code.startsWith('00') ? `\\x${code.slice(2)}` : json.slice(i, i + 6)));
      i += 5;
      start = i + 1;
    } else if (
      json[i + 1] === 'n' &&
      !ctx.implicitKey &&
      json[i + 2] !== '"' &&
      json.length >= MIN_MULTI_LINE_DOUBLE_QUOTED_LENGTH
    ) {
      // Folding turns the first of the written line breaks back into a space, hence the extra one.
      str += `${json.slice(start, i)}\n\n`;
      while (json[i + 2] === '\\' && json[i + 3] === 'n' && json[i + 4] !== '"') {
        str += '\n';
        i += 2;
      }
      str += indent;
      // A space after a line break would be folded away unless escaped.
      if (json[i + 2] === ' ') str += '\\';
      i++;
      start = i + 1;
    } else {
      i++;
    }
  }
  return start ? str + json.slice(start) : json;
}

function blockString(value: string, ctx: Context): string {
  let endStart = value.length;
  while (endStart > 0 && isBlockEndWhitespace(value.codePointAt(endStart - 1))) endStart--;
  let end = value.slice(endStart);
  // A block scalar cannot end with a whitespace-only line.
  if (end.includes('\n') && !end.endsWith('\n')) return quotedString(value, ctx);
  const indent = ctx.indent || (ctx.forceBlockIndent || containsDocumentMarker(value) ? INDENT_STEP : '');

  const endNewlinePos = end.indexOf('\n');
  const chomp = endNewlinePos === -1 ? '-' : value === end || endNewlinePos !== end.length - 1 ? '+' : '';
  if (end) {
    value = value.slice(0, -end.length);
    if (end.endsWith('\n')) end = end.slice(0, -1);
    end = end.replaceAll(/(?:^|(?<!\n))\n+(?!\n|$)/gu, `$&${indent}`);
  }

  const leadingWhitespace = /^[\n ]*/u.exec(value)?.[0] ?? '';
  const startsWithSpace = leadingWhitespace.includes(' ');
  let start = value.slice(0, leadingWhitespace.lastIndexOf('\n') + 1);
  if (start) {
    value = value.slice(start.length);
    start = start.replaceAll(/\n+/gu, `$&${indent}`);
  }

  const header = (startsWithSpace ? (indent ? '2' : '1') : '') + chomp;
  return `|${header}\n${indent}${start}${indentLines(value, indent)}${end}`;
}

/** Equivalent to `text.replaceAll(/\n+/g, `$&${indent}`)` for text without leading or trailing newlines, but faster. */
function indentLines(text: string, indent: string): string {
  const lines = text.split('\n');
  let str = lines[0] ?? '';
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    str += line ? `\n${indent}${line}` : '\n';
  }
  return str;
}

function isBlockEndWhitespace(codePoint: number | undefined): boolean {
  return codePoint === 0x0A || codePoint === 0x09 || codePoint === 0x20;
}
