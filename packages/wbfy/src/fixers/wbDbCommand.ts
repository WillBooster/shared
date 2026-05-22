import fs from 'node:fs/promises';

import fg from 'fast-glob';
import { PromisePool } from 'minimal-promise-pool';

import type { PackageConfig } from '../packageConfig.js';
import { fsUtil } from '../utils/fsUtil.js';
import { globIgnore } from '../utils/globUtil.js';

const wbDatabaseCommandRegex = /\bwb\s+(?:db|prisma)\b/gu;
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

export async function fixWbDbCommand(rootConfig: PackageConfig, packageConfigs = [rootConfig]): Promise<void> {
  if (rootConfig.repoAuthor === 'WillBooster' && rootConfig.repoName === 'shared') return;

  const promisePool = new PromisePool<void>();
  // `run()` resolves after a task enters the pool, while `promiseAll()` waits
  // for admitted tasks to finish. Both waits are needed to cover queued work.
  const replacementPromises: Promise<void>[] = [];
  for (const config of packageConfigs) {
    const command = selectWbDatabaseCommand(config);
    if (!command) continue;

    const filePaths = await fg(migrationTargets, {
      absolute: true,
      cwd: config.dirPath,
      dot: true,
      ignore: ['**/.git/**', ...(config.isRoot ? ['packages/**'] : []), ...globIgnore],
      onlyFiles: true,
    });
    for (const filePath of filePaths) {
      replacementPromises.push(promisePool.run(() => replaceWbDatabaseCommand(filePath, command)));
    }
  }
  await Promise.all(replacementPromises);
  await promisePool.promiseAll();
}

function selectWbDatabaseCommand(config: PackageConfig): 'wb db' | 'wb prisma' | undefined {
  if (config.depending.prisma) return 'wb prisma';
  if (config.depending.drizzle) return 'wb db';
}

async function replaceWbDatabaseCommand(filePath: string, command: 'wb db' | 'wb prisma'): Promise<void> {
  const content = await readTextFile(filePath);
  if (!content) return;

  // Temporary migration: normalize command spelling by ORM so Prisma keeps the
  // native command name while Drizzle uses the generic database command.
  const newContent = content.replaceAll(wbDatabaseCommandRegex, command);
  if (newContent === content) return;

  await fsUtil.generateFile(filePath, newContent);
}

async function readTextFile(filePath: string): Promise<string | undefined> {
  const stats = await fs.stat(filePath);
  if (stats.size > maxTextFileBytes) return undefined;

  const buffer = await fs.readFile(filePath);
  if (buffer.includes(0)) return undefined;

  return buffer.toString('utf8');
}
