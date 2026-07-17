import type { ParseError } from 'jsonc-parser';
import { createScanner, parse as parseJsonc } from 'jsonc-parser';

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
};
