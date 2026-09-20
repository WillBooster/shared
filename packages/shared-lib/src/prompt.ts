import { escapeRegExp, toTildeCodeBlock } from './text.js';

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
  escapedTags?: readonly string[];
}

/**
 * Serializes data into a code block to embed in an LLM prompt, so that the LLM can read its contents.
 * Accepts JSON data (honoring `toJSON` such as that of `Date`) as well as `undefined`, `NaN`, `Infinity`, bigints,
 * `Map`s (including non-string keys), `Set`s and other iterables, `Error`s (with their name, message, cause, and own properties),
 * and `RegExp`s. Symbols and functions without `toJSON` throw. The output is not meant to be deserialized back into the original value.
 * The format inside the code block is an implementation detail and may change.
 */
export function serializeForPrompt(value: unknown): string {
  return toTildeCodeBlock(`${stringifyValue(toSerializable(value), { indent: '' })}\n`, 'yaml');
}

/**
 * Serializes data with `serializeForPrompt` for embedding inside a `<tagName>` element of a prompt, escaping that tag
 * in every string so that untrusted data cannot close the element and have the rest read as instructions.
 * The caller must wrap the result in the same tag.
 *
 * Only the named elements are protected, so a block nested inside other tagged elements takes every enclosing name.
 * Escaping the finished block instead is not an option: it would turn a plain scalar holding the escaped notation
 * into a YAML flow sequence, since the quoting of each scalar is decided as it is written.
 *
 * The escaped notation is the one `escapePromptTag` writes, and text that already holds it is left as it is, so two
 * strings differing only in that notation are written alike. Keys taken from untrusted data can therefore collide
 * into one duplicate key of the emitted mapping.
 */
export function serializeForPromptInTag(value: unknown, tagName: string | readonly string[]): string {
  // Escaping is applied while writing each scalar, so that keys and the contents of Maps, Sets and Errors are covered
  // too, and so that a value starting with an escaped tag is still quoted as the string it is.
  const escapedTags = typeof tagName === 'string' ? [tagName] : tagName;
  return toTildeCodeBlock(`${stringifyValue(toSerializable(value), { indent: '', escapedTags })}\n`, 'yaml');
}

/**
 * Replaces every `<tagName` and `</tagName` in text with a harmless notation such as `[/tagName]`, so that data
 * embedded in a `<tagName>` element of a prompt cannot close the element and have the rest read as instructions.
 * A closing `>` is not required, since an HTML reader also closes an element on a tag carrying attribute-like junk,
 * on a trailing solidus, or on the next `>` anywhere in the prompt; the whitespace between `<` and the name is
 * dropped along with the brackets. Case is ignored deliberately: `tagName` is expected to be a literal written by
 * the caller, while the data is not.
 */
export function escapePromptTag(text: string, tagName: string): string {
  const name = escapeRegExp(tagName);
  // The first pattern keeps a well-formed tag readable as `[tagName]`; the second one catches every other spelling.
  return text
    .replaceAll(new RegExp(`<(/?)\\s*(${name})\\s*>`, 'giu'), '[$1$2]')
    .replaceAll(new RegExp(`<(/?)\\s*(${name})(?![\\w-])`, 'giu'), '[$1$2]');
}

/** The line opening a block of `serializeForPrompt`, with the indentation an interpolation may put before it. */
const BLOCK_OPENER = /^[ \t]*(~{3,})yaml[ \t]*$/u;

/** A block interpolated after other text on its line, which no rule can tell from prose that ends in `~~~yaml`. */
const MISPLACED_BLOCK_OPENER = /[^\s~][ \t]*~{3,}yaml[ \t]*$/u;

/**
 * Strips the indentation that nested template literals add to Markdown markers (headings and code fences) and
 * collapses blank lines, so that a prompt written inline reads as Markdown.
 * Blocks produced by `serializeForPrompt` are left untouched, since reindenting their lines would corrupt the YAML.
 * Such a block must be interpolated at the start of a line, and this throws when one is not: recognizing a block
 * is what keeps its contents intact, and after other text an opening fence cannot be told from prose.
 */
export function formatPrompt(prompt: string): string {
  const lines = prompt.split('\n');
  let formatted = '';
  let prose = '';
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    const fence = BLOCK_OPENER.exec(line)?.[1];
    const endIndex = fence === undefined ? -1 : findBlockEnd(lines, index, fence);
    if (endIndex === -1) {
      // An opening fence the prompt itself writes and never closes is prose, and so is every line inside a block.
      if (MISPLACED_BLOCK_OPENER.test(line)) {
        throw new TypeError('Interpolate a serializeForPrompt block at the start of a line');
      }
      prose += `${line}\n`;
      continue;
    }
    // Dropping the opener's indentation keeps four spaces of it from turning the fence into an indented code block.
    formatted += `${dedentPromptMarkers(prose)}${fence}yaml\n${lines.slice(index + 1, endIndex + 1).join('\n')}\n`;
    prose = '';
    index = endIndex;
  }
  return (formatted + dedentPromptMarkers(prose)).trim();
}

/**
 * Finds the line closing the block opened at `openerIndex`, or -1 when the prompt never closes it.
 * A `~` run shorter than the fence is content, since `serializeForPrompt` makes the fence longer than any run it
 * writes, while a run at least as long can only be the closing fence, whatever an interpolation put after it.
 */
function findBlockEnd(lines: string[], openerIndex: number, fence: string): number {
  const closer = new RegExp(`^${fence}~*(?:[ \\t].*)?$`, 'u');
  for (let index = openerIndex + 1; index < lines.length; index++) {
    if (!closer.test(lines[index] ?? '')) continue;
    return reachesBeyond(lines, openerIndex, index) ? -1 : index;
  }
  return -1;
}

/**
 * Whether a block opened between the two lines runs past `closerIndex`, which makes that line its content rather than
 * a closing fence: an opener the prompt writes as a sample and never closes would otherwise take a later block apart.
 */
function reachesBeyond(lines: string[], openerIndex: number, closerIndex: number): boolean {
  for (let index = openerIndex + 1; index < closerIndex; index++) {
    const fence = BLOCK_OPENER.exec(lines[index] ?? '')?.[1];
    if (fence !== undefined && findBlockEnd(lines, index, fence) >= closerIndex) return true;
  }
  return false;
}

function dedentPromptMarkers(text: string): string {
  return text
    .replaceAll(/\n\s+("""|'''|```|~{3,})/gu, '\n$1')
    .replaceAll(/\n\s+(#+\s)/gu, '\n$1')
    .replaceAll(/(?:\s*\n){2,}/gu, '\n\n');
}

/** Cuts text down to `maxLength` characters, marking it so that an LLM reads the rest as missing rather than absent. */
export function truncateForPrompt(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const kept = text.slice(0, maxLength);
  // Cutting between the halves of a surrogate pair would leave an unpaired one, which encoders replace with U+FFFD.
  return `${/[\uD800-\uDBFF]$/u.test(kept) ? kept.slice(0, -1) : kept}\n...<truncated>`;
}

// The functions below reproduce `stringify(value, { lineWidth: 0, aliasDuplicateObjects: false, blockQuote: 'literal' })`
// of the `yaml` package, except that `toSerializable` makes `Error`s and `RegExp`s readable instead of `{}`.

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
    case 'bigint': {
      return String(value);
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
        const itemCtx = { indent: ctx.indent + INDENT_STEP, escapedTags: ctx.escapedTags };
        for (const item of value as unknown[]) {
          str += `${str ? separator : ''}- ${stringifyValue(toSerializable(item), itemCtx)}`;
        }
        return str;
      }
      if (value instanceof Map) {
        for (const [key, item] of value) {
          if (item !== undefined) str += `${str ? separator : ''}${stringifyPair(key, item, ctx)}`;
        }
        return str || '{}';
      }
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        const item = record[key];
        if (item !== undefined) str += `${str ? separator : ''}${stringifyPair(key, item, ctx)}`;
      }
      return str || '{}';
    }
    default: {
      throw new TypeError(`Cannot serialize a ${typeof value} value for a prompt`);
    }
  }
}

function stringifyPair(rawKey: unknown, rawValue: unknown, ctx: Context): string {
  const indent = ctx.indent + INDENT_STEP;
  const key = toSerializable(rawKey);
  const value = toSerializable(rawValue);
  const keyStr = stringifyValue(key, { indent, implicitKey: true, escapedTags: ctx.escapedTags });
  const valueStr = stringifyValue(value, { indent, escapedTags: ctx.escapedTags });
  if (isCollection(key) || keyStr.length > MAX_IMPLICIT_KEY_LENGTH) return `? ${keyStr}\n${ctx.indent}: ${valueStr}`;
  const isBlockCollection = isCollection(value) && valueStr !== '[]' && valueStr !== '{}';
  return `${keyStr}:${isBlockCollection ? `\n${indent}` : ' '}${valueStr}`;
}

function toSerializable(rawValue: unknown): unknown {
  // Like `yaml`, call `toJSON` only once, but classify its result.
  const value =
    typeof (rawValue as { toJSON?: unknown } | null | undefined)?.toJSON === 'function'
      ? (rawValue as { toJSON: () => unknown }).toJSON()
      : rawValue;
  if (typeof value !== 'object' || value === null || Array.isArray(value) || value instanceof Map) return value;
  // oxlint-disable-next-line unicorn/no-instanceof-builtins -- boxed primitives have no typeof check; `yaml` unwraps them the same way.
  if (value instanceof String || value instanceof Number || value instanceof Boolean || value instanceof BigInt) {
    return value.valueOf();
  }
  if (value instanceof Error) {
    // `name` and `message` usually live on the prototype, and `cause` and `errors` are not enumerable.
    return {
      name: value.name,
      message: value.message,
      ...Object.fromEntries(Object.entries(value)),
      ...('cause' in value && { cause: value.cause }),
      ...(value instanceof AggregateError && { errors: value.errors }),
    };
  }
  if (value instanceof RegExp) return String(value);
  return Symbol.iterator in value ? [...(value as Iterable<unknown>)] : value;
}

function isCollection(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function stringifyNumber(value: number): string {
  if (Number.isNaN(value)) return '.nan';
  if (!Number.isFinite(value)) return value < 0 ? '-.inf' : '.inf';
  return Object.is(value, -0) ? '-0' : JSON.stringify(value);
}

function stringifyString(rawValue: string, ctx: Context): string {
  let value = rawValue;
  for (const tagName of ctx.escapedTags ?? []) value = escapePromptTag(value, tagName);
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
    if (indent === '') return blockString(value, ctx);
    if (implicitKey && indent === INDENT_STEP) return quotedString(value, ctx);
  }
  return NON_STRING_SCALAR.test(value) ? quotedString(value, ctx) : value;
}

function blockString(value: string, ctx: Context): string {
  let endStart = value.length;
  while (endStart > 0 && isBlockEndWhitespace(value.codePointAt(endStart - 1))) endStart--;
  let end = value.slice(endStart);
  // A block scalar cannot end with a whitespace-only line.
  if (end.includes('\n') && !end.endsWith('\n')) return quotedString(value, ctx);
  const indent = ctx.indent || (containsDocumentMarker(value) ? INDENT_STEP : '');

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

function quotedString(value: string, ctx: Context): string {
  return value.includes('"') && !value.includes("'") ? singleQuotedString(value, ctx) : doubleQuotedString(value, ctx);
}

function singleQuotedString(value: string, ctx: Context): string {
  // Every multi-line value reaching here would contain a space or tab next to a newline or be an implicit key,
  // both of which need double quotes.
  if (value.includes('\n')) return doubleQuotedString(value, ctx);
  return `'${value.replaceAll("'", "''")}'`;
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

function containsDocumentMarker(value: string): boolean {
  return /^(?:%|---|\.\.\.)/mu.test(value);
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
