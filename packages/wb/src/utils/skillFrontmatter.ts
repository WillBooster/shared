import fs from 'node:fs/promises';
import path from 'node:path';

import { getErrorMessage } from '@willbooster/shared-lib/src';
import { globby } from 'globby';
import { parse } from 'yaml';

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
    try {
      if (frontmatter?.index !== 0) {
        throw new Error('Missing or unclosed YAML frontmatter (expected --- delimiters).');
      }
      parse(frontmatter[1] ?? '', { logLevel: 'error' });
    } catch (error) {
      console.error(`${file}: invalid skill frontmatter: ${getErrorMessage(error)}`);
      hasErrors = true;
    }
  }
  return hasErrors;
}
