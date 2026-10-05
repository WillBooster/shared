import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { YAML } from 'bun';
import { expect, test } from 'bun:test';
import { z } from 'zod';

import { generateWorkflows } from '../../src/generators/workflow.js';
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
    const written = fs.readFileSync(filePath, 'utf8');
    const { jobs } = callerSchema.parse(YAML.parse(written));
    for (const job of Object.values(jobs)) expect(job.with?.github_hosted_runner).toBeUndefined();
    expect(jobs.test?.with?.runs_on).toBeUndefined();
    expect(jobs.test?.with?.custom_test_command).toBe(original.jobs.test.with.custom_test_command);
    expect(JSON.parse(String(jobs.custom?.with?.runs_on))).toEqual(labels);
    await generateWorkflows(config);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(written);
  });
});

test('private custom runner violations stop generation before any workflow is rewritten', async () => {
  await withTempWorkflowsRepo('wbfy-private-custom-', async (dirPath, workflowsPath) => {
    const filePath = path.join(workflowsPath, 'custom.yaml');
    const content = `jobs:\n  build:\n    strategy:\n      matrix:\n        runner: [ubuntu-latest, macos-latest]\n    runs-on: \${{ matrix.runner }}\n    steps:\n      - run: echo build\n`;
    fs.writeFileSync(filePath, content);
    await assert.rejects(
      generateWorkflows(createConfig({ dirPath, isRoot: true, isPublicRepo: false })),
      /jobs\.build\.runs-on/u
    );
    expect(fs.readFileSync(filePath, 'utf8')).toBe(content);
    expect(fs.readdirSync(workflowsPath)).toEqual(['custom.yaml']);
  });
});

test('private pinned release runners must be fixed before generation while valid callers remain unchanged', async () => {
  await withTempWorkflowsRepo('wbfy-private-pinned-', async (dirPath, workflowsPath) => {
    const filePath = path.join(workflowsPath, 'release.yml');
    const caller = {
      jobs: {
        release: {
          uses: 'WillBooster/reusable-workflows/.github/workflows/release.yml@v1.2.3',
          with: { github_hosted_runner: true, runs_on: JSON.stringify(['ubuntu-latest']) },
        },
      },
    };
    const config = createConfig({ dirPath, isRoot: true, repoAuthor: 'WillBooster', isPublicRepo: false });
    const unsafeContent = YAML.stringify(caller);
    fs.writeFileSync(filePath, unsafeContent);
    await assert.rejects(generateWorkflows(config), /jobs\.release\.with must select self-hosted/u);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(unsafeContent);
    expect(fs.readdirSync(workflowsPath)).toEqual(['release.yml']);

    caller.jobs.release.with = {
      github_hosted_runner: false,
      runs_on: JSON.stringify(['self-hosted', 'Linux', 'large']),
    };
    const safeContent = YAML.stringify(caller);
    fs.writeFileSync(filePath, safeContent);
    await generateWorkflows(config);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(safeContent);
    await generateWorkflows(config);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(safeContent);
  });
});
