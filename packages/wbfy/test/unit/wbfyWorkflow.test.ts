import fs from 'node:fs';
import path from 'node:path';

import { load } from 'js-yaml';
import { expect, test } from 'vitest';

import { generateWorkflows } from '../../src/generators/workflow.js';
import { promisePool } from '../../src/utils/promisePool.js';
import { createConfig } from '../helpers/testConfig.js';

// The self-applying nightly wbfy caller is retired: wbfy runs are driven by developers and
// agents directly. These tests pin the retirement behavior — no caller is generated, existing
// generated callers are deleted, and custom workflows that merely share the file name survive.

async function withTempRepo(callback: (dirPath: string, workflowsPath: string) => Promise<void>): Promise<void> {
  const tempRootPath = path.join(process.cwd(), '.tmp');
  await fs.promises.mkdir(tempRootPath, { recursive: true });
  const dirPath = await fs.promises.mkdtemp(path.join(tempRootPath, 'wbfy-self-apply-'));
  try {
    const workflowsPath = path.join(dirPath, '.github', 'workflows');
    await fs.promises.mkdir(workflowsPath, { recursive: true });
    await callback(dirPath, workflowsPath);
  } finally {
    await fs.promises.rm(dirPath, { recursive: true, force: true });
  }
}

test('generates no wbfy caller workflow', async () => {
  await withTempRepo(async (dirPath, workflowsPath) => {
    const config = createConfig({ dirPath, isRoot: true });
    await generateWorkflows(config);
    await promisePool.promiseAll();

    expect(fs.existsSync(path.join(workflowsPath, 'wbfy.yml'))).toBe(false);
    // The rest of the mandatory set is unaffected.
    expect(fs.existsSync(path.join(workflowsPath, 'test.yml'))).toBe(true);
  });
});

test('deletes an existing generated wbfy caller regardless of the calling organization', async () => {
  for (const repository of ['github:WillBooster/example', 'github:WillBoosterLab/example']) {
    await withTempRepo(async (dirPath, workflowsPath) => {
      await fs.promises.writeFile(
        path.join(workflowsPath, 'wbfy.yml'),
        `name: Willboosterify
on:
  schedule:
    - cron: 0 16 * * *
  workflow_dispatch:
jobs:
  wbfy:
    uses: ${repository === 'github:WillBooster/example' ? 'WillBooster' : 'WillBoosterLab'}/reusable-workflows/.github/workflows/wbfy.yml@main
    secrets:
      WBFY_GH_TOKEN: \${{ secrets.WBFY_GH_TOKEN }}
`
      );
      const config = createConfig({ dirPath, isRoot: true, isPublicRepo: false, repository });
      await generateWorkflows(config);
      await promisePool.promiseAll();

      expect(fs.existsSync(path.join(workflowsPath, 'wbfy.yml'))).toBe(false);
    });
  }
});

test('strips the retired push-back leftovers from an existing test caller', async () => {
  await withTempRepo(async (dirPath, workflowsPath) => {
    await fs.promises.writeFile(
      path.join(workflowsPath, 'test.yml'),
      `name: Test
on:
  pull_request:
  push:
    branches: [main, wbfy]
  workflow_dispatch:
permissions:
  actions: write
  contents: write
  pull-requests: read
  statuses: write
jobs:
  test:
    uses: WillBooster/reusable-workflows/.github/workflows/test.yml@main
`
    );
    const config = createConfig({ dirPath, isRoot: true });
    await generateWorkflows(config);
    await promisePool.promiseAll();

    const generated = load(await fs.promises.readFile(path.join(workflowsPath, 'test.yml'), 'utf8')) as {
      on: { push: { branches: string[] } };
      permissions: Record<string, string>;
    };
    expect(generated.on.push.branches).toEqual(['main']);
    expect(generated.permissions).toEqual({ actions: 'write', contents: 'write', 'pull-requests': 'read' });
  });
});

test('keeps a custom workflow that merely shares the wbfy.yml file name', async () => {
  await withTempRepo(async (dirPath, workflowsPath) => {
    const customContent = `on: workflow_dispatch
jobs:
  custom:
    runs-on: ubuntu-latest
    steps:
      - run: echo not a wbfy caller
`;
    await fs.promises.writeFile(path.join(workflowsPath, 'wbfy.yml'), customContent);
    const config = createConfig({ dirPath, isRoot: true });
    await generateWorkflows(config);
    await promisePool.promiseAll();

    expect(await fs.promises.readFile(path.join(workflowsPath, 'wbfy.yml'), 'utf8')).toBe(customContent);
  });
});
