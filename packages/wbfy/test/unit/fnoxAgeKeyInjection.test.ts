import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

import { generateFnoxToml, hasFnoxSyncFailed } from '../../src/generators/fnoxToml.js';
import { generateWorkflows } from '../../src/generators/workflow.js';
import { promisePool } from '../../src/utils/promisePool.js';
import { readCallerJob, withTempWorkflowsRepo } from '../helpers/callerWorkflow.js';
import { createConfig } from '../helpers/testConfig.js';

// A public repository's committed ciphertexts are world-readable, so its caller workflows must
// decrypt with the dedicated PUBLIC_FNOX_AGE_KEY organization secret; private repositories keep
// the org-internal FNOX_AGE_KEY. The callee always receives it under its declared FNOX_AGE_KEY name.

const defaultCallerContent = `name: Test
on:
  pull_request:
jobs:
  test:
    uses: WillBooster/reusable-workflows/.github/workflows/test.yml@main
    secrets:
      GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`;

function writeFnoxRepoFixture(dirPath: string, workflowsPath: string, callerContent: string): void {
  fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify({ name: 'plain' }));
  fs.writeFileSync(path.join(dirPath, 'fnox.toml'), '[secrets]\n');
  fs.writeFileSync(path.join(workflowsPath, 'test.yml'), callerContent);
}

test('maps FNOX_AGE_KEY from PUBLIC_FNOX_AGE_KEY in a public repository', async () => {
  await withTempWorkflowsRepo('wbfy-fnox-age-key-injection-', async (dirPath, workflowsPath) => {
    writeFnoxRepoFixture(dirPath, workflowsPath, defaultCallerContent);
    await generateWorkflows(createConfig({ dirPath, isRoot: true, isPublicRepo: true }));
    await promisePool.promiseAll();

    expect(readCallerJob(workflowsPath).secrets?.FNOX_AGE_KEY).toBe('${{ secrets.PUBLIC_FNOX_AGE_KEY }}');
  });
});

test('maps FNOX_AGE_KEY from the org-internal secret in a private repository', async () => {
  await withTempWorkflowsRepo('wbfy-fnox-age-key-injection-', async (dirPath, workflowsPath) => {
    writeFnoxRepoFixture(dirPath, workflowsPath, defaultCallerContent);
    await generateWorkflows(createConfig({ dirPath, isRoot: true, isPublicRepo: false }));
    await promisePool.promiseAll();

    expect(readCallerJob(workflowsPath).secrets?.FNOX_AGE_KEY).toBe('${{ secrets.FNOX_AGE_KEY }}');
  });
});

test('keeps an existing PUBLIC_FNOX_AGE_KEY mapping when the visibility lookup failed', async () => {
  await withTempWorkflowsRepo('wbfy-fnox-age-key-injection-', async (dirPath, workflowsPath) => {
    // The exact shape a failed GitHub lookup produces for a public repository: rewriting the
    // mapping to the org-internal secret on that guess would break the repository's CI.
    writeFnoxRepoFixture(
      dirPath,
      workflowsPath,
      defaultCallerContent.replace(
        'GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
        'FNOX_AGE_KEY: ${{ secrets.PUBLIC_FNOX_AGE_KEY }}'
      )
    );
    await generateWorkflows(createConfig({ dirPath, isRoot: true, isPublicRepo: false, isRepoVisibilityKnown: false }));
    await promisePool.promiseAll();

    expect(readCallerJob(workflowsPath).secrets?.FNOX_AGE_KEY).toBe('${{ secrets.PUBLIC_FNOX_AGE_KEY }}');
  });
});

test('keeps the org-internal mapping in a public WillBoosterLab repository', async () => {
  await withTempWorkflowsRepo('wbfy-fnox-age-key-injection-', async (dirPath, workflowsPath) => {
    writeFnoxRepoFixture(dirPath, workflowsPath, defaultCallerContent);
    // No CI identity is scoped to public WillBoosterLab repositories (the recipient sync fails
    // closed on them), so the caller must not be pointed at the nonexistent PUBLIC_FNOX_AGE_KEY.
    await generateWorkflows(
      createConfig({ dirPath, isRoot: true, isPublicRepo: true, repository: 'github:WillBoosterLab/example' })
    );
    await promisePool.promiseAll();

    expect(readCallerJob(workflowsPath).secrets?.FNOX_AGE_KEY).toBe('${{ secrets.FNOX_AGE_KEY }}');
  });
});

test('remaps an existing FNOX_AGE_KEY mapping of a pinned caller in a public repository', async () => {
  await withTempWorkflowsRepo('wbfy-fnox-age-key-injection-', async (dirPath, workflowsPath) => {
    writeFnoxRepoFixture(dirPath, workflowsPath, defaultCallerContent);
    fs.writeFileSync(
      path.join(workflowsPath, 'scheduled.yml'),
      `name: Scheduled
on:
  workflow_dispatch:
jobs:
  scheduled:
    uses: WillBooster/reusable-workflows/.github/workflows/run-script.yml@91fa583a4ce3e298b1edba90f941bab29271f693
    secrets:
      FNOX_AGE_KEY: \${{ secrets.FNOX_AGE_KEY }}
`
    );
    await generateWorkflows(createConfig({ dirPath, isRoot: true, isPublicRepo: true }));
    await promisePool.promiseAll();

    const job = readCallerJob(workflowsPath, 'scheduled.yml');
    expect(job.secrets?.FNOX_AGE_KEY).toBe('${{ secrets.PUBLIC_FNOX_AGE_KEY }}');
    // The pinned revision's other secret declarations are unknown, so nothing else is injected.
    expect(job.secrets?.TAKUMI_GUARD_TOKEN).toBeUndefined();
  });
});

test('does not remap FNOX_AGE_KEY while the fnox recipient sync failed', async () => {
  await withTempWorkflowsRepo('wbfy-fnox-age-key-injection-', async (dirPath, workflowsPath) => {
    writeFnoxRepoFixture(
      dirPath,
      workflowsPath,
      defaultCallerContent.replace('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}', 'FNOX_AGE_KEY: ${{ secrets.FNOX_AGE_KEY }}')
    );
    // generateFnoxToml refuses this fixture (its fnox.toml is invisible to git, and a leftover
    // migration marker also marks an interrupted migration): the ciphertexts may still target the
    // previous CI identity, so the workflow generator must not flip the key mapping either.
    fs.mkdirSync(path.join(dirPath, '.tmp'), { recursive: true });
    fs.writeFileSync(path.join(dirPath, '.tmp', 'wbfy-fnox-migration-marker'), '');
    try {
      const config = createConfig({ dirPath, isRoot: true, isPublicRepo: true });
      await generateFnoxToml(config);
      expect(hasFnoxSyncFailed()).toBe(true);
      await generateWorkflows(config);
      await promisePool.promiseAll();

      expect(readCallerJob(workflowsPath).secrets?.FNOX_AGE_KEY).toBe('${{ secrets.FNOX_AGE_KEY }}');
    } finally {
      // failFnoxSync sets the process-global exit code; reset it so this test run's own status
      // stays meaningful, and clear the module-level flag via a no-op non-WillBooster run.
      process.exitCode = 0;
      await generateFnoxToml(createConfig({ isWillBoosterRepo: false }));
    }
  });
});
