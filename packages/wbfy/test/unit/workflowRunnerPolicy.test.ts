import fs from 'node:fs';
import path from 'node:path';

import { YAML } from 'bun';
import { expect, test } from 'bun:test';
import { z } from 'zod';

import { generateWorkflows } from '../../src/generators/workflow.js';
import { promisePool } from '../../src/utils/promisePool.js';
import { withTempWorkflowsRepo } from '../helpers/callerWorkflow.js';
import { createConfig } from '../helpers/testConfig.js';

const callerSchema = z.object({
  jobs: z.record(z.string(), z.object({ with: z.record(z.string(), z.unknown()).optional() })),
});

test('rewriting private callers removes hosted overrides without losing custom runner constraints', async () => {
  await withTempWorkflowsRepo('wbfy-private-runners-', async (dirPath, workflowsPath) => {
    const labels = ['self-hosted', 'macOS', 'large'];
    const original = {
      jobs: {
        test: {
          uses: 'WillBooster/reusable-workflows/.github/workflows/test.yml@main',
          with: {
            github_hosted_runner: true,
            runs_on: JSON.stringify('ubuntu-22.04'),
            custom_test_command: 'bun run test/ci',
          },
        },
        custom: {
          uses: 'WillBooster/reusable-workflows/.github/workflows/run-script.yml@main',
          with: { github_hosted_runner: true, runs_on: JSON.stringify(labels) },
        },
      },
    };
    const filePath = path.join(workflowsPath, 'custom.yml');
    fs.writeFileSync(filePath, YAML.stringify(original));
    const config = createConfig({ dirPath, isRoot: true, isPublicRepo: false });
    await generateWorkflows(config);
    await promisePool.promiseAll();
    const written = fs.readFileSync(filePath, 'utf8');
    const { jobs } = callerSchema.parse(YAML.parse(written));
    for (const job of Object.values(jobs)) expect(job.with?.github_hosted_runner).toBeUndefined();
    expect(jobs.test?.with?.runs_on).toBeUndefined();
    expect(jobs.test?.with?.custom_test_command).toBe(original.jobs.test.with.custom_test_command);
    expect(JSON.parse(String(jobs.custom?.with?.runs_on))).toEqual(labels);
    await generateWorkflows(config);
    await promisePool.promiseAll();
    expect(fs.readFileSync(filePath, 'utf8')).toBe(written);
  });
});

test('private custom runner violations stop generation before any workflow is rewritten', async () => {
  await withTempWorkflowsRepo('wbfy-private-custom-', async (dirPath, workflowsPath) => {
    const filePath = path.join(workflowsPath, 'custom.yaml');
    const content = `jobs:\n  build:\n    strategy:\n      matrix:\n        runner: [ubuntu-latest, macos-latest]\n    runs-on: \${{ matrix.runner }}\n    steps:\n      - run: echo build\n`;
    fs.writeFileSync(filePath, content);
    await expect(generateWorkflows(createConfig({ dirPath, isRoot: true, isPublicRepo: false }))).rejects.toThrow(
      'jobs.build.runs-on'
    );
    expect(fs.readFileSync(filePath, 'utf8')).toBe(content);
    expect(fs.readdirSync(workflowsPath)).toEqual(['custom.yaml']);
  });
});
