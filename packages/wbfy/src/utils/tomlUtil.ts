import assert from 'node:assert';

import { parse as parseToml } from 'smol-toml';

/**
 * Sets `key = "value"` in the bare `[table]` section with a line edit, so comments and every other
 * setting are kept as written; a missing section or key is added.
 * A line edit breaks values written in any other form (a multi-line value, a dotted key, a
 * sub-table), so this throws instead of returning content the parser disagrees with.
 */
export function setTomlTableString(content: string, table: string, key: string, value: string): string {
  const newContent = replaceTomlTableString(content, table, key, value);
  assert.ok(
    readTomlTable(newContent, table)?.[key] === value,
    `Write ${key} as one \`${key} = ...\` line under a bare [${table}] header.`
  );
  return newContent;
}

function replaceTomlTableString(content: string, table: string, key: string, value: string): string {
  const line = `${key} = "${value}"`;
  const section = new RegExp(String.raw`^\[${table}\](?![^\n])(?:\n(?!\[).*)*`, 'mu').exec(content)?.[0];
  if (section === undefined) return `${content && `${content.trimEnd()}\n\n`}[${table}]\n${line}\n`;

  const linePattern = new RegExp(`^${key} = .*?(\\s*#.*)?$`, 'mu');
  // Blank lines and comments that end the section lead the next table, so a new line goes above them.
  const linesEnd = /(?:\n[\t ]*(?:#.*)?)*$/u.exec(section)?.index ?? section.length;
  const newSection = linePattern.test(section)
    ? section.replace(linePattern, `${line}$1`)
    : `${section.slice(0, linesEnd)}\n${line}${section.slice(linesEnd)}`;
  return content.replace(section, () => newSection);
}

function readTomlTable(content: string, table: string): Record<string, unknown> | undefined {
  try {
    return (parseToml(content) as Record<string, Record<string, unknown> | undefined>)[table];
  } catch {
    return undefined;
  }
}
