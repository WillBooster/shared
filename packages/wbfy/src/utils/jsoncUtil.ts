import { isDeepStrictEqual } from 'node:util';

import type { ParseError } from 'jsonc-parser';
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
    // Prepend rather than append the properties that are new: appending detaches a trailing
    // same-line comment from the last property, leaving it to describe the generated value
    // instead. Inserting in reverse keeps the order the settings declare them in.
    for (const [key, value] of newEntries.toReversed()) {
      this.content = applyEdits(
        this.content,
        modify(this.content, [...jsonPath, key], value, { ...this.modifyOptions, getInsertionIndex: () => 0 })
      );
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
      this.content = applyEdits(
        this.content,
        modify(this.content, [...jsonPath, insertion.index], insertion.value, {
          ...this.modifyOptions,
          isArrayInsertion: true,
        })
      );
      this.content = restoreTrailingComment(this.content, jsonPath, insertion.index);
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
    this.reportLostComments(jsonPath, valueTextOf(this.content, jsonPath));
    this.content = removeMember(this.content, jsonPath);
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

// The whole same-line comment sequence, not just the first one: a line comment ends it (it runs to
// the newline), but any number of block comments can precede it, and moving only the first would
// leave the rest describing the wrong element.
const trailingCommentPattern = /^(?:[^\S\n]*\/\*[\S\s]*?\*\/)*(?:[^\S\n]*\/\/[^\n]*)?/u;

/**
 * Reattaches a same-line comment to the element it describes. Inserting into an array places the
 * new element BEFORE the trivia that follows its predecessor, so appending after
 * `{ ... } // why this rule exists` leaves that comment explaining the generated element instead.
 * A freshly serialized element never carries a comment of its own, so anything trailing the
 * insertion belonged to the element before it.
 */
function restoreTrailingComment(content: string, arrayPath: JsonPath, insertedIndex: number): string {
  if (insertedIndex === 0) return content;
  const root = parseTree(content);
  const elements = (root && findNodeAtLocation(root, arrayPath))?.children;
  const inserted = elements?.[insertedIndex];
  const previous = elements?.[insertedIndex - 1];
  if (!inserted || !previous) return content;
  const insertedEnd = inserted.offset + inserted.length;
  const comment = trailingCommentPattern.exec(content.slice(insertedEnd))?.[0];
  if (!comment) return content;
  // Land the comment after the separating comma so the element keeps its own line intact.
  const previousEnd = previous.offset + previous.length;
  const restoreOffset = previousEnd + (/^\s*,/u.exec(content.slice(previousEnd))?.[0].length ?? 0);
  return (
    content.slice(0, restoreOffset) +
    comment +
    content.slice(restoreOffset, insertedEnd) +
    content.slice(insertedEnd + comment.length)
  );
}

/**
 * Removes the array element or object property at `jsonPath` together with its separating comma,
 * its same-line trailing comment, and the comment-only lines directly above it. jsonc-parser's own
 * removal is not used: it keeps a stray character of a removed last array element on compact
 * input, leaves a bare comma behind a removed last property followed by a trailing comma, and
 * deletes the comments that precede the next element.
 */
function removeMember(content: string, jsonPath: JsonPath): string {
  const root = parseTree(content);
  const valueNode = root && findNodeAtLocation(root, jsonPath);
  const member = valueNode?.parent?.type === 'property' ? valueNode.parent : valueNode;
  const siblings = member?.parent?.children;
  if (!member || !siblings) return content;
  const previous = siblings[siblings.indexOf(member) - 1];
  const lineStart = content.lastIndexOf('\n', member.offset - 1) + 1;
  const ownsLine = /^[\t ]*$/u.test(content.slice(lineStart, member.offset));
  const start = ownsLine ? extendOverLeadingCommentLines(content, lineStart) : member.offset;
  let end = member.offset + member.length;
  const comma = findComma(content, end);
  // Without a comma after it, the member is the last one, so the comma before it must go instead.
  const removedCommaOffset = comma
    ? undefined
    : previous && findComma(content, previous.offset + previous.length)?.offset;
  if (comma) end = comma.offset + 1;
  end += trailingCommentPattern.exec(content.slice(end))?.[0].length ?? 0;
  end += (ownsLine ? /^[^\S\n]*\n?/u : /^[^\S\n]*/u).exec(content.slice(end))?.[0].length ?? 0;
  const before =
    removedCommaOffset === undefined
      ? content.slice(0, start)
      : content.slice(0, removedCommaOffset) + content.slice(removedCommaOffset + 1, start);
  return before + content.slice(end);
}

/** Returns the comma that is the next token after `offset`, skipping comments and whitespace. */
function findComma(content: string, offset: number): { offset: number } | undefined {
  const scanner = createScanner(content, true);
  scanner.setPosition(offset);
  return (scanner.scan() as number) === syntaxKind.commaToken ? { offset: scanner.getTokenOffset() } : undefined;
}

/** Moves `lineStart` up over the comment-only lines directly above it, which describe that line. */
function extendOverLeadingCommentLines(content: string, lineStart: number): number {
  let start = lineStart;
  while (start > 0) {
    const previousLineStart = content.lastIndexOf('\n', start - 2) + 1;
    if (!/^[^\S\n]*(?:\/\/[^\n]*|\/\*(?:(?!\*\/)[^\n])*\*\/[^\S\n]*)\n$/u.test(content.slice(previousLineStart, start)))
      break;
    start = previousLineStart;
  }
  return start;
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
