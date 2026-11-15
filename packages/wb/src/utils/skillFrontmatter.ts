import fs from 'node:fs/promises';
import path from 'node:path';

import { spawnAsync } from '@willbooster/shared-lib-node/src';
import { getErrorMessage } from '@willbooster/shared-lib/src';
import { globby } from 'globby';
import { parse } from 'yaml';

import { isInTestFixtures } from './japaneseSpacing.js';

export async function reportSkillFrontmatterErrors(rootDir: string, targets: string[]): Promise<boolean> {
  const resolvedTargets = targets.map((target) => path.resolve(target));
  const files = await listSkillFiles(rootDir);
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

async function listSkillFiles(rootDir: string): Promise<string[]> {
  const files = await globby('**/SKILL.md', {
    cwd: rootDir,
    absolute: true,
    dot: true,
    gitignore: true,
    followSymbolicLinks: false,
    ignore: ['**/node_modules/**', '**/.git/**', '**/.tmp/**'],
  });
  if (files.length === 0) return files;
  const workTree = await spawnAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: rootDir });
  if (workTree.status !== 0 || workTree.stdout.trim() !== 'true') return files;
  const result = await spawnAsync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: rootDir,
  });
  if (result.status !== 0) throw new Error(`Cannot list skill Git files: ${result.stderr}`);
  const ownedFiles = new Set(
    result.stdout
      .split('\0')
      .filter(Boolean)
      .map((file) => path.resolve(rootDir, file))
  );
  return files.filter((file) => ownedFiles.has(file));
}
