import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'bun:test';

import { generateWorkflows } from '../../src/generators/workflow.js';
import { promisePool } from '../../src/utils/promisePool.js';
import { readCallerJob, withTempWorkflowsRepo } from '../helpers/callerWorkflow.js';
import { createConfig } from '../helpers/testConfig.js';

// VERDACCIO_TOKEN flows into a reusable-workflow caller only when the repository actually
// resolves @willbooster-private/* packages; TAKUMI_GUARD_TOKEN is passed unconditionally
// (an unset secret expands to '' and the callee treats that as "feature off").

test('omits VERDACCIO_TOKEN and even removes an existing pass-through when no private package is used', async () => {
  await withTempWorkflowsRepo('wbfy-verdaccio-injection-', async (dirPath, workflowsPath) => {
    fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify({ name: 'plain' }));
    // A previously generated caller carries the pass-through; regeneration must strip it.
    fs.writeFileSync(
      path.join(workflowsPath, 'test.yml'),
      `name: Test
on:
  pull_request:
jobs:
  test:
    uses: WillBooster/reusable-workflows/.github/workflows/test.yml@main
    secrets:
      VERDACCIO_TOKEN: \${{ secrets.VERDACCIO_TOKEN }}
`
    );
    await generateWorkflows(createConfig({ dirPath, isRoot: true }));
    await promisePool.promiseAll();

    const job = readCallerJob(workflowsPath);
    expect(job.secrets?.VERDACCIO_TOKEN).toBeUndefined();
    expect(job.secrets?.TAKUMI_GUARD_TOKEN).toBe('${{ secrets.TAKUMI_GUARD_TOKEN }}');
  });
});

test('passes VERDACCIO_TOKEN when a private package is depended upon', async () => {
  await withTempWorkflowsRepo('wbfy-verdaccio-injection-', async (dirPath, workflowsPath) => {
    fs.writeFileSync(
      path.join(dirPath, 'package.json'),
      JSON.stringify({ name: 'consumer', devDependencies: { '@willbooster-private/agentic-workflows': '1.0.0' } })
    );
    await generateWorkflows(createConfig({ dirPath, isRoot: true }));
    await promisePool.promiseAll();

    const job = readCallerJob(workflowsPath);
    expect(job.secrets?.VERDACCIO_TOKEN).toBe('${{ secrets.VERDACCIO_TOKEN }}');
    expect(job.secrets?.TAKUMI_GUARD_TOKEN).toBe('${{ secrets.TAKUMI_GUARD_TOKEN }}');
  });
});
