import { isDeepStrictEqual } from 'node:util';

import type { Node as JsonNode, ParseError } from 'jsonc-parser';
import { applyEdits, createScanner, findNodeAtLocation, modify, parse as parseJsonc, parseTree } from 'jsonc-parser';

// jsonc-parser declares SyntaxKind/ScanError as ambient const enums, which cannot be imported
// under verbatimModuleSyntax; mirror the needed member values locally.
const syntaxKind = {
  commaToken: 5,
  lineCommentTrivia: 12,
  blockCommentTrivia: 13,
  lineBreakTrivia: 14,
  trivia: 15,
  eof: 17,
};
const scanErrorNone = 0;

export const jsoncUtil = {
  /**
   * Tells whether the content holds no configuration at all — only whitespace, complete comments,
   * and/or a BOM. tsc treats such a tsconfig.json as an empty config, so generators should treat
   * it like a missing file (and generate defaults) instead of refusing to manage it. Lexically
   * broken trivia (e.g. an unterminated block comment) is NOT trivia-only: the file must be left
   * untouched rather than overwritten with defaults.
   */
  isTriviaOnly(content: string): boolean {
    const scanner = createScanner(content.replace(/^\uFEFF/, ''));
    for (let kind: number = scanner.scan(); kind !== syntaxKind.eof; kind = scanner.scan()) {
      if (
        (scanner.getTokenError() as number) !== scanErrorNone ||
        (kind !== syntaxKind.lineCommentTrivia &&
          kind !== syntaxKind.blockCommentTrivia &&
          kind !== syntaxKind.trivia &&
          kind !== syntaxKind.lineBreakTrivia)
      ) {
        return false;
      }
    }
    return true;
  },
  /**
   * Parses a JSONC (JSON with comments) object from config files such as tsconfig.json,
   * pyrightconfig.json, renovate.json, .vscode/settings.json, and wrangler.jsonc.
   *
   * jsonc-parser is fault tolerant and returns a partial object for malformed input, which must
   * not be treated as the file's configuration; reject any parse error instead. A leading BOM is
   * stripped because TypeScript accepts BOM'd config files while jsonc-parser reports the BOM as
   * a parse error. Callers whose reader rejects trailing commas turn `allowTrailingComma`
   * off so such a file is reported as malformed here too.
   */
  parseObjectIgnoringError<T extends object>(content: string, allowTrailingComma = true): T | undefined {
    const parseErrors: ParseError[] = [];
    const value = parseJsonc(content.replace(/^\uFEFF/, ''), parseErrors, { allowTrailingComma }) as T | undefined;
    return parseErrors.length === 0 && !!value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : undefined;
  },
  /** Tells whether the content carries at least one comment, i.e. content JSON.stringify would drop. */
  containsComment(content: string): boolean {
    const scanner = createScanner(content.replace(/^\uFEFF/, ''));
    for (let kind: number = scanner.scan(); kind !== syntaxKind.eof; kind = scanner.scan()) {
      // A lexical error means the remaining tokens are unreliable; report no comment rather than
      // guessing. A caller that only warns about dropped comments loses nothing, and one that
      // refuses a commented file for a strict-JSON reader still rejects such content when it
      // parses it.
      if ((scanner.getTokenError() as number) !== scanErrorNone) return false;
      if (kind === syntaxKind.lineCommentTrivia || kind === syntaxKind.blockCommentTrivia) return true;
    }
    return false;
  },
  /**
   * Serializes `settings` into `oldContent`, editing only the properties and array elements whose
   * values changed so the comments and formatting of an existing file survive. A top-level property
   * missing from `settings` is left untouched unless `removeMissing` is set; to delete one
   * otherwise, set its key to `undefined`. A nested property missing from `settings` is removed.
   *
   * Trivia-only content keeps its comments as a header above the generated object, rather than
   * being replaced outright or run through modify() (which would move the object in front of them).
   */
  stringifyPreservingTrivia(
    oldContent: string | undefined,
    settings: Record<string, unknown>,
    removeMissing = false
  ): { content: string; keysLosingComments: string[] } {
    if (oldContent === undefined) {
      return { content: JSON.stringify(settings, undefined, 2), keysLosingComments: [] };
    }

    const oldSettings = jsoncUtil.parseObjectIgnoringError<Record<string, unknown>>(oldContent);
    // Drop a leading BOM: modify() inserts the generated object BEFORE any leading trivia, which
    // would leave the BOM stranded mid-file where it is a syntax error rather than an ignored mark.
    let content = oldContent.replace(/^\uFEFF/, '');
    if (jsoncUtil.isTriviaOnly(content)) {
      const header = content.trim();
      return {
        content: `${header ? header + '\n' : ''}${JSON.stringify(settings, undefined, 2)}`,
        keysLosingComments: [],
      };
    }
    const editor = new PreservingEditor(content);
    editor.editObject([], oldSettings ?? {}, settings, removeMissing);
    const expectedSettings = removeMissing ? settings : { ...oldSettings, ...settings };
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- The round trip drops `undefined` properties, which mark deletions; structuredClone would keep them.
    const expected = JSON.parse(JSON.stringify(expectedSettings)) as Record<string, unknown>;
    // The edits work on source text, so an unforeseen combination of comments and commas could
    // still yield a broken file; writing the settings out whole is lossy but always valid.
    if (!isDeepStrictEqual(jsoncUtil.parseObjectIgnoringError(editor.content), expected)) {
      const keysWithComments = Object.keys(oldSettings ?? {}).filter((key) =>
        jsoncUtil.containsComment(valueTextOf(content, [key]) ?? '')
      );
      return { content: JSON.stringify(expected, undefined, 2), keysLosingComments: keysWithComments };
    }
    return { content: editor.content, keysLosingComments: editor.keysLosingComments };
  },
};

type JsonPath = (string | number)[];

/**
 * Applies the difference between two parsed values to JSONC source one property or element at a
 * time, so the comments and formatting of everything left unchanged survive.
 */
class PreservingEditor {
  content: string;
  readonly keysLosingComments: string[] = [];
  private readonly modifyOptions: { formattingOptions: { insertSpaces: boolean; tabSize: number } };

  constructor(content: string) {
    this.content = content;
    this.modifyOptions = { formattingOptions: detectFormattingOptions(content) };
  }

  /**
   * Edits the properties of the object at `jsonPath`, removing those missing from `newValue` when
   * `removeMissing` is set (nested objects always set it, as replacing the whole object would).
   */
  editObject(
    jsonPath: JsonPath,
    oldValue: Record<string, unknown>,
    newValue: Record<string, unknown>,
    removeMissing: boolean
  ): void {
    const newEntries: [string, unknown][] = [];
    for (const [key, value] of Object.entries(newValue)) {
      const oldPropertyValue = oldValue[key];
      // Compare serialized forms so deep-equal values (e.g. a re-merged `extends` array) do not
      // rewrite the property and reflow its formatting.
      if (JSON.stringify(oldPropertyValue) === JSON.stringify(value)) continue;
      if (oldPropertyValue === undefined) {
        newEntries.push([key, value]);
        continue;
      }
      this.editValue([...jsonPath, key], oldPropertyValue, value);
    }
    if (removeMissing) {
      for (const key of Object.keys(oldValue)) {
        if (!Object.hasOwn(newValue, key)) this.remove([...jsonPath, key]);
      }
    }
    // Prepend the properties that are new, in reverse to keep the order the settings declare them in.
    for (const [key, value] of newEntries.toReversed()) {
      this.insert(jsonPath, 0, value, key);
    }
  }

  private editValue(jsonPath: JsonPath, oldValue: unknown, newValue: unknown): void {
    if (isPlainObject(oldValue) && isPlainObject(newValue)) {
      this.editObject(jsonPath, oldValue, newValue, true);
      return;
    }
    // Replacing a whole array would discard the comments inside and between its elements, so
    // remove and insert elements one by one whenever the new value keeps the old elements' order.
    const arrayEdits =
      Array.isArray(oldValue) && Array.isArray(newValue) ? findArrayEdits(oldValue, newValue) : undefined;
    if (!arrayEdits) {
      this.replace(jsonPath, newValue);
      return;
    }
    for (const index of arrayEdits.removals.toReversed()) {
      this.remove([...jsonPath, index]);
    }
    for (const insertion of arrayEdits.insertions) {
      this.insert(jsonPath, insertion.index, insertion.value);
    }
  }

  /**
   * Rewrites (or, with `undefined`, removes) the whole value at `jsonPath`, which takes any comment
   * nested inside it along. Report that under its top-level key rather than losing it quietly.
   */
  private replace(jsonPath: JsonPath, value: unknown): void {
    if (value === undefined) {
      this.remove(jsonPath);
      return;
    }
    this.reportLostComments(jsonPath, valueTextOf(this.content, jsonPath));
    this.content = applyEdits(this.content, modify(this.content, jsonPath, value, this.modifyOptions));
  }

  private remove(jsonPath: JsonPath): void {
    const container = nodeAt(this.content, jsonPath.slice(0, -1));
    const key = jsonPath.at(-1);
    const members = container?.children ?? [];
    const index =
      typeof key === 'number' ? key : members.findIndex((property) => property.children?.[0]?.value === key);
    if (!container || index === -1) return;
    const regions = memberRegions(this.content, container);
    const region = regions[index];
    if (!region) return;
    const member = members[index];
    if (!member) return;
    const removedRanges: [number, number][] = [[region.start, region.end]];
    // When the next member continues the removed member's line, keep that line's indentation for it.
    const memberLineStart = this.content.lastIndexOf('\n', member.offset - 1) + 1;
    if (this.content[region.end - 1] !== '\n' && memberLineStart >= region.start) {
      const indentationEnd =
        memberLineStart + (/^[^\S\n]*/u.exec(this.content.slice(memberLineStart))?.[0].length ?? 0);
      const spacesAfter = /^[^\S\n]*/u.exec(this.content.slice(region.end))?.[0].length ?? 0;
      removedRanges.splice(0, 1, [region.start, memberLineStart], [indentationEnd, region.end + spacesAfter]);
    } else if (index === 0 && this.content[region.end - 1] !== '\n') {
      removedRanges.splice(0, 1, [
        region.start,
        region.end + (/^[^\S\n]*/u.exec(this.content.slice(region.end))?.[0].length ?? 0),
      ]);
    }
    // Without a comma of its own, the member is the last one, so the comma before it must go instead.
    const previousComma = regions[index - 1]?.commaOffset;
    if (region.commaOffset === undefined && previousComma !== undefined) {
      removedRanges.unshift([previousComma, previousComma + 1]);
    }
    this.reportLostComments(jsonPath, removedRanges.map(([start, end]) => this.content.slice(start, end)).join(''));
    for (const [start, end] of removedRanges.toReversed()) {
      this.content = this.content.slice(0, start) + this.content.slice(end);
    }
  }

  /**
   * Inserts `value` as the member at `index` of the container at `jsonPath` (as property `key` of an
   * object), between the source regions of its neighbours so that no comment changes its member.
   */
  private insert(jsonPath: JsonPath, index: number, value: unknown, key?: string): void {
    const container = nodeAt(this.content, jsonPath);
    const members = container?.children ?? [];
    const firstMember = members[0];
    if (!container || !firstMember) {
      this.content = applyEdits(
        this.content,
        modify(this.content, [...jsonPath, key ?? index], value, { ...this.modifyOptions, isArrayInsertion: true })
      );
      return;
    }
    const regions = memberRegions(this.content, container);
    const multiline = this.content.slice(container.offset + 1, firstMember.offset).includes('\n');
    const lineStart = this.content.lastIndexOf('\n', firstMember.offset - 1) + 1;
    const indentation = multiline ? (/^[^\S\n]*/u.exec(this.content.slice(lineStart))?.[0] ?? '') : '';
    const { insertSpaces, tabSize } = this.modifyOptions.formattingOptions;
    const valueText = multiline
      ? JSON.stringify(value, undefined, insertSpaces ? ' '.repeat(tabSize) : '\t').replaceAll('\n', `\n${indentation}`)
      : JSON.stringify(value);
    const memberText = key === undefined ? valueText : `${JSON.stringify(key)}: ${valueText}`;
    const region = regions[index];
    if (region) {
      const text = multiline ? `${indentation}${memberText},\n` : index === 0 ? `${memberText}, ` : ` ${memberText},`;
      this.content = this.content.slice(0, region.start) + text + this.content.slice(region.start);
      return;
    }
    const last = regions.at(-1);
    const lastMember = members.at(-1);
    if (!last || !lastMember) return;
    const endsLine = this.content[last.end - 1] === '\n';
    const hasTrailingComma = last.commaOffset !== undefined;
    const lineBreak = multiline && !endsLine ? '\n' : '';
    const text = multiline
      ? `${lineBreak}${indentation}${memberText}${hasTrailingComma ? ',' : ''}${endsLine ? '\n' : ''}`
      : ` ${memberText}${hasTrailingComma ? ',' : ''}`;
    const lastMemberEnd = lastMember.offset + lastMember.length;
    this.content = hasTrailingComma
      ? this.content.slice(0, last.end) + text + this.content.slice(last.end)
      : this.content.slice(0, lastMemberEnd) +
        ',' +
        this.content.slice(lastMemberEnd, last.end) +
        text +
        this.content.slice(last.end);
  }

  private reportLostComments(jsonPath: JsonPath, removedText: string | undefined): void {
    const key = String(jsonPath[0]);
    if (removedText !== undefined && jsoncUtil.containsComment(removedText) && !this.keysLosingComments.includes(key)) {
      this.keysLosingComments.push(key);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns the source text of the value at `jsonPath`, comments and all. */
function valueTextOf(content: string, jsonPath: JsonPath): string | undefined {
  const root = parseTree(content);
  const node = root && findNodeAtLocation(root, jsonPath);
  return node && content.slice(node.offset, node.offset + node.length);
}

// A same-line comment sequence: any number of block comments, optionally closed by a line comment.
const trailingCommentPattern = /^(?:[^\S\n]*\/\*[\S\s]*?\*\/)*(?:[^\S\n]*\/\/[^\n]*)?/u;

function nodeAt(content: string, jsonPath: JsonPath): JsonNode | undefined {
  const root = parseTree(content);
  return root && (jsonPath.length === 0 ? root : findNodeAtLocation(root, jsonPath));
}

interface MemberRegion {
  start: number;
  end: number;
  commaOffset: number | undefined;
}

/**
 * Splits the members of a container into contiguous source regions, each holding the member and
 * the comments that document it: the comment lines above it (or an inline comment between the
 * preceding separator and it), its own comma, and its same-line trailing comment. A comment that
 * shares its line with the next member documents that member instead, so the region ends at the
 * comma then. The comments after the opening bracket on its line and after the last region belong
 * to the container and lie outside every region.
 */
function memberRegions(content: string, container: JsonNode): MemberRegion[] {
  const members = container.children ?? [];
  const regions: MemberRegion[] = [];
  let start = container.offset + 1;
  const firstMember = members[0];
  if (firstMember && content.slice(start, firstMember.offset).includes('\n')) start += lineTailLength(content, start);
  for (const [index, member] of members.entries()) {
    const next = members[index + 1];
    const comma = findComma(content, member.offset + member.length);
    let end = comma ? comma.offset + 1 : member.offset + member.length;
    if (!next || content.slice(end, next.offset).includes('\n')) end += lineTailLength(content, end);
    regions.push({ start, end, commaOffset: comma?.offset });
    start = end;
  }
  return regions;
}

/**
 * Returns the length of the same-line comments at `offset` plus, when nothing else follows them on
 * that line, the rest of the line including its line break.
 */
function lineTailLength(content: string, offset: number): number {
  const comments = trailingCommentPattern.exec(content.slice(offset))?.[0] ?? '';
  const lineEnd = /^[^\S\n]*\n/u.exec(content.slice(offset + comments.length))?.[0] ?? '';
  return comments.length + lineEnd.length;
}

/** Returns the comma that is the next token after `offset`, skipping comments and whitespace. */
function findComma(content: string, offset: number): { offset: number } | undefined {
  const scanner = createScanner(content, true);
  scanner.setPosition(offset);
  return (scanner.scan() as number) === syntaxKind.commaToken ? { offset: scanner.getTokenOffset() } : undefined;
}

/**
 * Mirrors the indentation the file already uses, so a semantic change does not reindent unrelated
 * lines. The first property is measured rather than the first indented line, because a decorated
 * block comment (` * ...`) would otherwise pass for the file's indentation. Falls back to the two
 * spaces every generated config uses.
 */
function detectFormattingOptions(content: string): { insertSpaces: boolean; tabSize: number } {
  const firstProperty = parseTree(content)?.children?.[0];
  const indentation =
    firstProperty && content.slice(content.lastIndexOf('\n', firstProperty.offset) + 1, firstProperty.offset);
  if (!indentation || !/^[\t ]+$/u.test(indentation)) return { insertSpaces: true, tabSize: 2 };
  if (indentation.startsWith('\t')) return { insertSpaces: false, tabSize: 1 };
  return { insertSpaces: true, tabSize: indentation.length };
}

/**
 * Returns the edits that turn `oldValue` into `newValue` while keeping the old elements that
 * survive, or undefined when that is impossible because `newValue` reorders them (the caller must
 * then replace the array wholesale). `removals` are ascending indices into `oldValue`; removing
 * them right to left and then applying `insertions` left to right (their indices address the
 * array as it grows) yields `newValue`.
 */
function findArrayEdits(
  oldValue: unknown[],
  newValue: unknown[]
): { removals: number[]; insertions: { index: number; value: unknown }[] } | undefined {
  const oldTexts = oldValue.map((element) => JSON.stringify(element));
  const removals: number[] = [];
  const insertions: { index: number; value: unknown }[] = [];
  let oldIndex = 0;
  for (const [newIndex, element] of newValue.entries()) {
    const matchedIndex = oldTexts.indexOf(JSON.stringify(element), oldIndex);
    if (matchedIndex === -1) {
      insertions.push({ index: newIndex, value: element });
      continue;
    }
    for (; oldIndex < matchedIndex; oldIndex++) removals.push(oldIndex);
    oldIndex++;
  }
  for (; oldIndex < oldTexts.length; oldIndex++) removals.push(oldIndex);
  // A reordered element shows up as both removed and inserted; rewriting the array keeps the
  // result readable instead of moving elements piecemeal.
  const removedTexts = new Set(removals.map((index) => oldTexts[index]));
  if (insertions.some((insertion) => removedTexts.has(JSON.stringify(insertion.value)))) return undefined;
  return { removals, insertions };
}
