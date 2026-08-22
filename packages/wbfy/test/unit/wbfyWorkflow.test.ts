import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'bun:test';

import { generateWorkflows } from '../../src/generators/workflow.js';
import { promisePool } from '../../src/utils/promisePool.js';
import { createConfig } from '../helpers/testConfig.js';

// The self-applying nightly wbfy caller is not part of the generated workflow set.

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
