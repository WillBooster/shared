import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { fixWbDbCommand } from '../src/fixers/wbDbCommand.js';
import { createConfig } from './testConfig.js';

test('migrates legacy wb prisma commands while preserving prisma subcommands', async () => {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wbfy-wb-db-command-'));
  const dockerfilePath = path.join(dirPath, 'Dockerfile');
  const packageJsonPath = path.join(dirPath, 'package.json');

  await fs.writeFile(
    dockerfilePath,
    `RUN yarn wb prisma db push
RUN yarn wb prisma create-litestream-config
RUN yarn wb prisma db migrate`
  );
  await fs.writeFile(packageJsonPath, JSON.stringify({ scripts: { 'db-reset': 'wb prisma reset' } }));

  try {
    await fixWbDbCommand(createConfig({ dirPath, repoAuthor: 'WillBoosterLab', repoName: 'example' }));

    await expect(fs.readFile(dockerfilePath, 'utf8')).resolves.toBe(
      `RUN yarn wb db db push
RUN yarn wb db create-litestream-config
RUN yarn wb db db migrate
`
    );
    await expect(fs.readFile(packageJsonPath, 'utf8')).resolves.toBe(
      `${JSON.stringify({ scripts: { 'db-reset': 'wb db reset' } })}\n`
    );
  } finally {
    await fs.rm(dirPath, { force: true, recursive: true });
  }
});
