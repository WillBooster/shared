import type { ParseError } from 'jsonc-parser';
import { parse as parseJsonc } from 'jsonc-parser';

export const jsoncUtil = {
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
