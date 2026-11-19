import assert from 'node:assert';
import { isDeepStrictEqual } from 'node:util';

import { parse as parseToml } from 'smol-toml';

/**
 * Sets `key = "value"` in the `[table]` section with a line edit, so comments and every other
 * setting are kept as written; a missing section or key is added.
 * Dotted keys and sub-tables are rejected rather than returning content the parser disagrees with.
 */
export function setTomlTableString(content: string, table: string, key: string, value: string): string {
  return setTomlTableValue(content, table, key, value);
}

export function setTomlTableValue(
  content: string,
  table: string,
  key: string,
  value: string | Record<string, string | string[]>
): string {
  const literal =
    typeof value === 'string'
      ? JSON.stringify(value)
      : `{ ${Object.entries(value)
          .map(([name, entry]) => `${name} = ${JSON.stringify(entry)}`)
          .join(', ')} }`;
  const newContent = replaceTomlTableValue(content, table, key, literal);
  assert.ok(
    isDeepStrictEqual(readTomlTable(newContent, table)?.[key], parseToml(`value = ${literal}`).value),
    `Write ${key} as one \`${key} = ...\` line under the [${table}] header.`
  );
  return newContent;
}

function replaceTomlTableValue(content: string, table: string, key: string, literal: string): string {
  const line = `${key} = ${literal}`;
  const section = new RegExp(String.raw`^\[${table}\][\t ]*(?:#.*)?$(?:\n(?!\[).*)*`, 'mu').exec(content)?.[0];
  if (section === undefined) return `${content && `${content.trimEnd()}\n\n`}[${table}]\n${line}\n`;

  const linePattern = new RegExp(`^${key} = .*?(\\s*#.*)?$`, 'mu');
  // Blank lines and comments that end the section lead the next table, so a new line goes above them.
  const linesEnd = /(?:\n[\t ]*(?:#.*)?)*$/u.exec(section)?.index ?? section.length;
  const match = linePattern.exec(section);
  const newSection = match
    ? replaceAssignment(section, match, line)
    : `${section.slice(0, linesEnd)}\n${line}${section.slice(linesEnd)}`;
  return content.replace(section, () => newSection);
}

function replaceAssignment(section: string, match: RegExpExecArray, line: string): string {
  // Bun formats generated inline tables with multiline arrays. Replace the complete
  // assignment so the formatter's continuation lines cannot survive a pin update.
  const start = match.index;
  let end = start + match[0].length;
  while (true) {
    try {
      parseToml(section.slice(start, end));
      break;
    } catch {
      const nextLine = section.indexOf('\n', end + 1);
      if (end === section.length) throw new Error('Cannot find the end of a TOML assignment.');
      end = nextLine === -1 ? section.length : nextLine;
    }
  }
  const comment = /[\t ]*#.*$/u.exec(section.slice(start, end).split('\n').at(-1) ?? '')?.[0] ?? '';
  return `${section.slice(0, start)}${line}${comment}${section.slice(end)}`;
}

function readTomlTable(content: string, table: string): Record<string, unknown> | undefined {
  try {
    return (parseToml(content) as Record<string, Record<string, unknown> | undefined>)[table];
  } catch {
    return undefined;
  }
}
