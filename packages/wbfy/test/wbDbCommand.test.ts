import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { fixWbDbCommand } from '../src/fixers/wbDbCommand.js';
import { createConfig } from './testConfig.js';

test('uses wb prisma for prisma projects', async () => {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wbfy-wb-db-command-'));
  const dockerfilePath = path.join(dirPath, 'Dockerfile');
  const packageJsonPath = path.join(dirPath, 'package.json');

  await fs.writeFile(
    dockerfilePath,
    `RUN yarn wb prisma db push
RUN yarn wb prisma create-litestream-config
RUN yarn wb db db migrate`
  );
  await fs.writeFile(packageJsonPath, JSON.stringify({ scripts: { 'db-reset': 'wb db reset' } }));

  try {
    await fixWbDbCommand(
      createConfig({
        dirPath,
        depending: { ...createConfig().depending, prisma: true },
        repoAuthor: 'WillBoosterLab',
        repoName: 'example',
      })
    );

    await expect(fs.readFile(dockerfilePath, 'utf8')).resolves.toBe(
      `RUN yarn wb prisma db push
RUN yarn wb prisma create-litestream-config
RUN yarn wb prisma db migrate
`
    );
    await expect(fs.readFile(packageJsonPath, 'utf8')).resolves.toBe(
      `${JSON.stringify({ scripts: { 'db-reset': 'wb prisma reset' } })}\n`
    );
  } finally {
    await fs.rm(dirPath, { force: true, recursive: true });
  }
});

test('uses wb db for drizzle projects', async () => {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wbfy-wb-db-command-'));
  const packageJsonPath = path.join(dirPath, 'package.json');

  await fs.writeFile(packageJsonPath, JSON.stringify({ scripts: { 'db-reset': 'wb prisma reset' } }));

  try {
    await fixWbDbCommand(
      createConfig({
        dirPath,
        depending: { ...createConfig().depending, drizzle: true },
        repoAuthor: 'WillBoosterLab',
        repoName: 'example',
      })
    );

    await expect(fs.readFile(packageJsonPath, 'utf8')).resolves.toBe(
      `${JSON.stringify({ scripts: { 'db-reset': 'wb db reset' } })}\n`
    );
  } finally {
    await fs.rm(dirPath, { force: true, recursive: true });
  }
});

test('root pass covers pattern-matched directories without a manifest but not processed packages', async () => {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wbfy-wb-db-command-'));
  const webPackagePath = path.join(dirPath, 'apps', 'web');
  const docsDirPath = path.join(dirPath, 'apps', 'docs');

  await fs.mkdir(webPackagePath, { recursive: true });
  await fs.mkdir(docsDirPath, { recursive: true });
  await fs.writeFile(
    path.join(dirPath, 'package.json'),
    JSON.stringify({ name: 'root', workspaces: ['apps/*'], scripts: { migrate: 'wb db push' } })
  );
  // apps/web is a processed package with its own pass; apps/docs matches the workspace pattern
  // but has no manifest, so ONLY the root pass can migrate its files.
  await fs.writeFile(path.join(webPackagePath, 'package.json'), JSON.stringify({ scripts: { migrate: 'wb db push' } }));
  await fs.writeFile(path.join(docsDirPath, 'setup.md'), 'Run `wb db push`.\n');

  try {
    const rootConfig = createConfig({
      dirPath,
      isRoot: true,
      depending: { ...createConfig().depending, prisma: true },
      packageJson: { workspaces: ['apps/*'] },
      repoAuthor: 'WillBoosterLab',
      repoName: 'example',
    });
    const webConfig = createConfig({
      dirPath: webPackagePath,
      depending: { ...createConfig().depending, drizzle: true },
    });
    await fixWbDbCommand(rootConfig, [rootConfig, webConfig]);

    await expect(fs.readFile(path.join(docsDirPath, 'setup.md'), 'utf8')).resolves.toBe('Run `wb prisma push`.\n');
    // The web package is shielded from the root pass and its own drizzle pass is a no-op, so the
    // file stays byte-identical (a root-pass rewrite would have stamped `wb prisma push`).
    await expect(fs.readFile(path.join(webPackagePath, 'package.json'), 'utf8')).resolves.toBe(
      JSON.stringify({ scripts: { migrate: 'wb db push' } })
    );
  } finally {
    await fs.rm(dirPath, { force: true, recursive: true });
  }
});

test('normalizes monorepo packages independently', async () => {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wbfy-wb-db-command-'));
  const prismaPackagePath = path.join(dirPath, 'packages', 'prisma-app');
  const drizzlePackagePath = path.join(dirPath, 'packages', 'drizzle-app');

  await fs.mkdir(prismaPackagePath, { recursive: true });
  await fs.mkdir(drizzlePackagePath, { recursive: true });
  await fs.writeFile(
    path.join(prismaPackagePath, 'package.json'),
    JSON.stringify({ scripts: { migrate: 'wb db db push' } })
  );
  await fs.writeFile(
    path.join(drizzlePackagePath, 'package.json'),
    JSON.stringify({ scripts: { migrate: 'wb prisma push' } })
  );

  try {
    const rootConfig = createConfig({ dirPath, isRoot: true, repoAuthor: 'WillBoosterLab', repoName: 'example' });
    await fixWbDbCommand(rootConfig, [
      rootConfig,
      createConfig({
        dirPath: prismaPackagePath,
        depending: { ...createConfig().depending, prisma: true },
      }),
      createConfig({
        dirPath: drizzlePackagePath,
        depending: { ...createConfig().depending, drizzle: true },
      }),
    ]);

    await expect(fs.readFile(path.join(prismaPackagePath, 'package.json'), 'utf8')).resolves.toBe(
      `${JSON.stringify({ scripts: { migrate: 'wb prisma db push' } })}\n`
    );
    await expect(fs.readFile(path.join(drizzlePackagePath, 'package.json'), 'utf8')).resolves.toBe(
      `${JSON.stringify({ scripts: { migrate: 'wb db push' } })}\n`
    );
  } finally {
    await fs.rm(dirPath, { force: true, recursive: true });
  }
});
