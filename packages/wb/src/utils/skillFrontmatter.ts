import fs from 'node:fs/promises';
import path from 'node:path';

import { globby } from 'globby';
import { parseDocument } from 'yaml';

import { isInTestFixtures } from './japaneseSpacing.js';

export async function reportSkillFrontmatterErrors(rootDir: string, targets: string[]): Promise<boolean> {
  const resolvedTargets = targets.map((target) => path.resolve(target));
  const files = await globby('**/SKILL.md', {
    cwd: rootDir,
    absolute: true,
    dot: true,
    gitignore: true,
    followSymbolicLinks: false,
    ignore: ['**/node_modules/**', '**/.git/**', '**/.tmp/**'],
  });
  let hasErrors = false;
  for (const file of files) {
    if (isInTestFixtures(file) || !resolvedTargets.some((target) => file === target || file.startsWith(`${target}/`))) {
      continue;
    }
    const text = await fs.readFile(file, 'utf8');
    const frontmatter = /^(\uFEFF?---\r?\n[\s\S]*?)^---[\t ]*(?:\r?\n|$)/m.exec(text);
    const errors =
      frontmatter?.index === 0
        ? parseDocument(frontmatter[1] ?? '').errors.map((error) => error.message)
        : ['Missing or unclosed YAML frontmatter (expected --- delimiters).'];
    for (const error of errors) {
      console.error(`${file}: invalid skill frontmatter: ${error}`);
      hasErrors = true;
    }
  }
  return hasErrors;
}
