import fs from 'node:fs';
import path from 'node:path';

import { load } from 'js-yaml';
import { expect, test } from 'vitest';

import { generateWorkflows } from '../../src/generators/workflow.js';
import { promisePool } from '../../src/utils/promisePool.js';
import { createConfig } from '../helpers/testConfig.js';

// VERDACCIO_TOKEN flows into a reusable-workflow caller only when the repository actually
// resolves @willbooster-private/* packages; TAKUMI_GUARD_TOKEN is passed unconditionally
// (an unset secret expands to '' and the callee treats that as "feature off").

async function withTempRepo(callback: (dirPath: string, workflowsPath: string) => Promise<void>): Promise<void> {
  const tempRootPath = path.join(process.cwd(), '.tmp');
  await fs.promises.mkdir(tempRootPath, { recursive: true });
  const dirPath = await fs.promises.mkdtemp(path.join(tempRootPath, 'wbfy-verdaccio-injection-'));
  try {
    const workflowsPath = path.join(dirPath, '.github', 'workflows');
    await fs.promises.mkdir(workflowsPath, { recursive: true });
    await callback(dirPath, workflowsPath);
  } finally {
    await fs.promises.rm(dirPath, { recursive: true, force: true });
  }
}

interface CallerJob {
  secrets?: Record<string, string>;
}

function readTestCallerJob(workflowsPath: string): CallerJob {
  const parsed = load(fs.readFileSync(path.join(workflowsPath, 'test.yml'), 'utf8')) as {
    jobs: Record<string, CallerJob>;
  };
  const job = Object.values(parsed.jobs)[0];
  expect(job).toBeDefined();
  // The non-null assertion is checked by the expect above.
  return job as CallerJob;
}

test('omits VERDACCIO_TOKEN and even removes an existing pass-through when no private package is used', async () => {
  await withTempRepo(async (dirPath, workflowsPath) => {
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

    const job = readTestCallerJob(workflowsPath);
    expect(job.secrets?.VERDACCIO_TOKEN).toBeUndefined();
    expect(job.secrets?.TAKUMI_GUARD_TOKEN).toBe('${{ secrets.TAKUMI_GUARD_TOKEN }}');
  });
});

test('passes VERDACCIO_TOKEN when a private package is depended upon', async () => {
  await withTempRepo(async (dirPath, workflowsPath) => {
    fs.writeFileSync(
      path.join(dirPath, 'package.json'),
      JSON.stringify({ name: 'consumer', devDependencies: { '@willbooster-private/agentic-workflows': '1.0.0' } })
    );
    await generateWorkflows(createConfig({ dirPath, isRoot: true }));
    await promisePool.promiseAll();

    const job = readTestCallerJob(workflowsPath);
    expect(job.secrets?.VERDACCIO_TOKEN).toBe('${{ secrets.VERDACCIO_TOKEN }}');
    expect(job.secrets?.TAKUMI_GUARD_TOKEN).toBe('${{ secrets.TAKUMI_GUARD_TOKEN }}');
  });
});
