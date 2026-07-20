import type { ParseError } from 'jsonc-parser';
import { applyEdits, createScanner, modify, parse as parseJsonc, parseTree } from 'jsonc-parser';

// jsonc-parser declares SyntaxKind/ScanError as ambient const enums, which cannot be imported
// under verbatimModuleSyntax; mirror the needed member values locally.
const syntaxKind = { lineCommentTrivia: 12, blockCommentTrivia: 13, lineBreakTrivia: 14, trivia: 15, eof: 17 };
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
   * a parse error.
   */
  parseObjectIgnoringError<T extends object>(content: string): T | undefined {
    const parseErrors: ParseError[] = [];
    const value = parseJsonc(content.replace(/^\uFEFF/, ''), parseErrors, { allowTrailingComma: true }) as
      | T
      | undefined;
    return parseErrors.length === 0 && !!value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : undefined;
  },
  /** Tells whether the content carries at least one comment, i.e. content JSON.stringify would drop. */
  containsComment(content: string): boolean {
    const scanner = createScanner(content.replace(/^\uFEFF/, ''));
    for (let kind: number = scanner.scan(); kind !== syntaxKind.eof; kind = scanner.scan()) {
      // A lexical error means the remaining tokens are unreliable; report no comment rather than
      // guessing, since callers only use this to decide whether to warn about dropped comments.
      if ((scanner.getTokenError() as number) !== scanErrorNone) return false;
      if (kind === syntaxKind.lineCommentTrivia || kind === syntaxKind.blockCommentTrivia) return true;
    }
    return false;
  },
  /**
   * Tells whether the object declares the same top-level property twice. Such content cannot be
   * edited in place: this module's parser keeps the LAST occurrence (matching JSON.parse) while
   * jsonc-parser's modify() rewrites the FIRST, so an edit would land on the occurrence that does
   * not take effect and be re-applied on every run.
   */
  hasDuplicateTopLevelKey(content: string): boolean {
    const keys = (parseTree(content.replace(/^\uFEFF/, ''))?.children ?? []).map(
      (property) => property.children?.[0]?.value as unknown
    );
    return new Set(keys).size !== keys.length;
  },
  /**
   * Serializes `settings` into `oldContent`, editing only the top-level properties whose values
   * changed so the comments and formatting of an existing file survive. Callers never drop
   * properties (generated settings are merged ON TOP of the existing ones), so removals are not
   * handled: a property missing from `settings` is left untouched rather than deleted.
   *
   * Trivia-only content is edited rather than replaced too, so its comments survive (modify()
   * appends the generated object before them).
   */
  stringifyPreservingTrivia(oldContent: string | undefined, settings: Record<string, unknown>): string {
    if (oldContent === undefined) return JSON.stringify(settings, undefined, 2);

    const oldSettings = jsoncUtil.parseObjectIgnoringError<Record<string, unknown>>(oldContent);
    let content = oldContent;
    for (const [key, value] of Object.entries(settings)) {
      const oldValue = oldSettings?.[key];
      // Compare serialized forms so deep-equal values (e.g. a re-merged `extends` array) do not
      // rewrite the property and reflow its formatting.
      if (JSON.stringify(oldValue) === JSON.stringify(value)) continue;
      // Replacing a whole array would discard the comments between its elements, so grow it with
      // per-element insertions whenever the new value only adds to it.
      const insertions = Array.isArray(oldValue) && Array.isArray(value) ? findInsertions(oldValue, value) : undefined;
      for (const insertion of insertions ?? []) {
        content = applyEdits(
          content,
          modify(content, [key, insertion.index], insertion.value, { ...modifyOptions, isArrayInsertion: true })
        );
      }
      if (insertions) continue;
      content = applyEdits(content, modify(content, [key], value, modifyOptions));
    }
    return content;
  },
};

const modifyOptions = { formattingOptions: { insertSpaces: true, tabSize: 2 } };

/**
 * Returns the elements to insert into `oldValue` to turn it into `newValue`, or undefined when
 * that is impossible because `newValue` drops or reorders an existing element (the caller must
 * then replace the array wholesale). Indices address the array as it grows, so applying the
 * insertions left to right yields `newValue`.
 */
function findInsertions(oldValue: unknown[], newValue: unknown[]): { index: number; value: unknown }[] | undefined {
  const insertions: { index: number; value: unknown }[] = [];
  let oldIndex = 0;
  for (const [newIndex, element] of newValue.entries()) {
    if (oldIndex < oldValue.length && JSON.stringify(oldValue[oldIndex]) === JSON.stringify(element)) {
      oldIndex++;
      continue;
    }
    insertions.push({ index: newIndex, value: element });
  }
  return oldIndex === oldValue.length ? insertions : undefined;
}
