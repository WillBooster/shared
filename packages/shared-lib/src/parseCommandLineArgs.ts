/**
 * Parses a command line string into an array of arguments, preserving quoted strings.
 *
 * This function handles:
 * - Space-separated arguments
 * - Double-quoted strings (preserves spaces within)
 * - Single-quoted strings (preserves spaces within)
 *
 * @param argsString The command line string to parse
 * @returns An array of parsed arguments
 */
export function parseCommandLineArgs(argsString: string): string[] {
  if (!argsString) return [];

  const result: string[] = [];
  let current = '';
  let inDoubleQuote = false;
  let inSingleQuote = false;

  for (const char of argsString) {
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (char === ' ' && !inDoubleQuote && !inSingleQuote) {
      if (current) {
        result.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) {
    result.push(current);
  }

  return result;
}
