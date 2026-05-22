import fs from 'node:fs/promises';

import fg from 'fast-glob';

import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { globIgnore } from '../utils/globUtil.js';

const oldCommand = 'wb prisma';
const newCommand = 'wb db';
const oldPrismaDbCommand = 'wb prisma db';
const maxTextFileBytes = 1024 * 1024;
const migrationTargets = [
  '**/*.{cjs,cts,js,json,jsx,md,mdc,mjs,mts,sh,tsx,ts,toml,txt,yaml,yml}',
  '**/.env',
  '**/.env.*',
  '**/.github/workflows/*',
  '**/.gitignore',
  '**/.dockerignore',
  '**/Dockerfile',
  '**/Dockerfile.*',
  '**/Makefile',
  '**/mise.toml',
  '**/.mise.toml',
  '**/lefthook.yml',
  '**/package.json',
];

export async function fixWbDbCommand(rootConfig: PackageConfig): Promise<void> {
  if (rootConfig.repoAuthor === 'WillBooster' && rootConfig.repoName === 'shared') return;

  const filePaths = await fg(migrationTargets, {
    absolute: true,
    cwd: rootConfig.dirPath,
    dot: true,
    ignore: ['**/.git/**', ...globIgnore],
    onlyFiles: true,
  });

  await Promise.all(filePaths.map(replaceWbPrismaCommand));
}

async function replaceWbPrismaCommand(filePath: string): Promise<void> {
  const content = await readTextFile(filePath);
  if (!content?.includes(oldCommand)) return;

  // Temporary migration: remove this fixer after all repositories have been
  // migrated from the legacy `wb prisma` spelling to `wb db`. Some repositories
  // used `wb prisma db ...`, so the optional `db` segment must collapse instead
  // of producing `wb db db ...`.
  await fsUtil.generateFile(
    filePath,
    content.replaceAll(oldPrismaDbCommand, newCommand).replaceAll(oldCommand, newCommand)
  );
}

async function readTextFile(filePath: string): Promise<string | undefined> {
  const stats = await fs.stat(filePath);
  if (stats.size > maxTextFileBytes) return undefined;

  const buffer = await fs.readFile(filePath);
  if (buffer.includes(0)) return undefined;

  return buffer.toString('utf8');
}
