import fs from 'node:fs';
import path from 'node:path';

import { load } from 'js-yaml';
import { expect, test } from 'vitest';

import { generateWorkflows } from '../../src/generators/workflow.js';
import { promisePool } from '../../src/utils/promisePool.js';
import { createConfig } from '../helpers/testConfig.js';

// A public repository's committed ciphertexts are world-readable, so its caller workflows must
// decrypt with the dedicated PUBLIC_FNOX_AGE_KEY organization secret; private repositories keep
// the org-internal FNOX_AGE_KEY. The callee always receives it under its declared FNOX_AGE_KEY name.

async function withTempRepo(callback: (dirPath: string, workflowsPath: string) => Promise<void>): Promise<void> {
  const tempRootPath = path.join(process.cwd(), '.tmp');
  await fs.promises.mkdir(tempRootPath, { recursive: true });
  const dirPath = await fs.promises.mkdtemp(path.join(tempRootPath, 'wbfy-fnox-age-key-injection-'));
  try {
    const workflowsPath = path.join(dirPath, '.github', 'workflows');
    await fs.promises.mkdir(workflowsPath, { recursive: true });
    fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify({ name: 'plain' }));
    fs.writeFileSync(path.join(dirPath, 'fnox.toml'), '[secrets]\n');
    fs.writeFileSync(
      path.join(workflowsPath, 'test.yml'),
      `name: Test
on:
  pull_request:
jobs:
  test:
    uses: WillBooster/reusable-workflows/.github/workflows/test.yml@main
    secrets:
      GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`
    );
    await callback(dirPath, workflowsPath);
  } finally {
    await fs.promises.rm(dirPath, { recursive: true, force: true });
  }
}

function readTestCallerFnoxAgeKey(workflowsPath: string): string | undefined {
  const parsed = load(fs.readFileSync(path.join(workflowsPath, 'test.yml'), 'utf8')) as {
    jobs: Record<string, { secrets?: Record<string, string> }>;
  };
  const job = Object.values(parsed.jobs)[0];
  expect(job).toBeDefined();
  return job?.secrets?.FNOX_AGE_KEY;
}

test('maps FNOX_AGE_KEY from PUBLIC_FNOX_AGE_KEY in a public repository', async () => {
  await withTempRepo(async (dirPath, workflowsPath) => {
    await generateWorkflows(createConfig({ dirPath, isRoot: true, isPublicRepo: true }));
    await promisePool.promiseAll();

    expect(readTestCallerFnoxAgeKey(workflowsPath)).toBe('${{ secrets.PUBLIC_FNOX_AGE_KEY }}');
  });
});

test('maps FNOX_AGE_KEY from the org-internal secret in a private repository', async () => {
  await withTempRepo(async (dirPath, workflowsPath) => {
    await generateWorkflows(createConfig({ dirPath, isRoot: true, isPublicRepo: false }));
    await promisePool.promiseAll();

    expect(readTestCallerFnoxAgeKey(workflowsPath)).toBe('${{ secrets.FNOX_AGE_KEY }}');
  });
});
