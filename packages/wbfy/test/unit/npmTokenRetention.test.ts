import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

import { generateWorkflows } from '../../src/generators/workflow.js';
import { promisePool } from '../../src/utils/promisePool.js';
import { readCallerJob, withTempWorkflowsRepo } from '../helpers/callerWorkflow.js';
import { createConfig } from '../helpers/testConfig.js';

// The @main release workflow declares an optional NPM_TOKEN for registry.npmjs.org token
// publishes, so a release caller's mapping is a deliberate configuration; every other callee
// still rejects the secret as undeclared, so leftover mappings there must be stripped.

test('keeps NPM_TOKEN on a release caller but strips it from a test caller', async () => {
  await withTempWorkflowsRepo('wbfy-npm-token-retention-', async (dirPath, workflowsPath) => {
    fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify({ name: 'publisher' }));
    fs.writeFileSync(
      path.join(workflowsPath, 'release.yml'),
      `name: Release
on:
  push:
    branches: [main]
jobs:
  release:
    uses: WillBooster/reusable-workflows/.github/workflows/release.yml@main
    secrets:
      NPM_TOKEN: \${{ secrets.NPM_TOKEN }}
`
    );
    fs.writeFileSync(
      path.join(workflowsPath, 'test.yml'),
      `name: Test
on:
  pull_request:
jobs:
  test:
    uses: WillBooster/reusable-workflows/.github/workflows/test.yml@main
    secrets:
      NPM_TOKEN: \${{ secrets.NPM_TOKEN }}
`
    );
    await generateWorkflows(
      createConfig({
        dirPath,
        isRoot: true,
        release: { branches: ['main'], github: true, npm: true, npmPublishesRoot: true },
      })
    );
    await promisePool.promiseAll();

    expect(readCallerJob(workflowsPath, 'release.yml').secrets?.NPM_TOKEN).toBe('${{ secrets.NPM_TOKEN }}');
    expect(readCallerJob(workflowsPath).secrets?.NPM_TOKEN).toBeUndefined();
  });
});
