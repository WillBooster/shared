// oxlint-disable eslint-plugin-import/no-named-as-default-member -- Namespace YAML calls make load/dump usage clearer.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import yaml from 'js-yaml';
import { expect, test } from 'vitest';

import {
  generateSelfContainedWorkflows,
  selfContainedWorkflowMarker,
} from '../../src/generators/selfContainedWorkflow.js';
import { promisePool } from '../../src/utils/promisePool.js';
import { createConfig } from '../helpers/testConfig.js';

interface ParsedWorkflow {
  jobs: Record<
    string,
    {
      steps: {
        run?: string;
        uses?: string;
        env?: Record<string, string>;
        'working-directory'?: string;
        with?: Record<string, unknown>;
      }[];
    }
  >;
}

test('generates self-contained test and semantic-pr workflows without reusable-workflow callers', async () => {
  await withTempRepo(async (dirPath) => {
    const config = createConfig({
      dirPath,
      isRoot: true,
      isWillBoosterRepo: false,
      repository: 'github:someone/example',
    });
    await generateSelfContainedWorkflows(config);
    await promisePool.promiseAll();

    const testContent = await fs.readFile(path.join(dirPath, '.github', 'workflows', 'test.yml'), 'utf8');
    expect(testContent.startsWith(selfContainedWorkflowMarker)).toBe(true);
    expect(testContent).not.toContain('reusable-workflows');
    const testWorkflow = yaml.load(testContent) as ParsedWorkflow;
    const runCommands = testWorkflow.jobs.test?.steps.map((step) => step.run).filter(Boolean);
    expect(runCommands).toContain('bun install');
    expect(runCommands).toContain('bun run test/ci');
    // No TypeScript and no Playwright in this repository.
    expect(runCommands).not.toContain('bun run typecheck');
    expect(testContent).not.toContain('playwright');
    // No fnox.toml, so no FNOX_AGE_KEY reference.
    expect(testContent).not.toContain('FNOX_AGE_KEY');

    const semanticPrContent = await fs.readFile(path.join(dirPath, '.github', 'workflows', 'semantic-pr.yml'), 'utf8');
    expect(semanticPrContent.startsWith(selfContainedWorkflowMarker)).toBe(true);
    expect(semanticPrContent).toContain('amannn/action-semantic-pull-request');
  });
});

test('includes typecheck, Playwright caching and step-scoped FNOX_AGE_KEY when the repository needs them', async () => {
  await withTempRepo(async (dirPath) => {
    await fs.writeFile(path.join(dirPath, 'fnox.toml'), '[secrets]\n');
    const config = createConfig({
      dirPath,
      isRoot: true,
      isWillBoosterRepo: false,
      repository: 'github:someone/example',
      doesContainTypeScript: true,
      depending: { ...createConfig().depending, playwrightTest: true },
    });
    await generateSelfContainedWorkflows(config);
    await promisePool.promiseAll();

    const content = await fs.readFile(path.join(dirPath, '.github', 'workflows', 'test.yml'), 'utf8');
    const workflow = yaml.load(content) as ParsedWorkflow;
    const steps = workflow.jobs.test?.steps ?? [];
    expect(steps.map((step) => step.run)).toContain('bun run typecheck');
    expect(steps.some((step) => step.uses?.startsWith('actions/cache@'))).toBe(true);
    expect(content).toContain('playwright install --with-deps');
    // Step-scoped, not job-wide: `bun install` must not see the age identity.
    const installStep = steps.find((step) => step.run === 'bun install');
    expect(installStep?.env).toBeUndefined();
    const testStep = steps.find((step) => step.run === 'bun run test/ci');
    expect(testStep?.env?.FNOX_AGE_KEY).toBe('${{ secrets.FNOX_AGE_KEY }}');
  });
});

test('installs Playwright browsers from the declaring workspace package in a monorepo', async () => {
  await withTempRepo(async (dirPath) => {
    const rootConfig = createConfig({
      dirPath,
      isRoot: true,
      isWillBoosterRepo: false,
      repository: 'github:someone/example',
    });
    const childConfig = createConfig({
      dirPath: path.join(dirPath, 'packages', 'app'),
      isWillBoosterRepo: false,
      repository: 'github:someone/example',
      depending: { ...createConfig().depending, playwrightTest: true },
    });
    await generateSelfContainedWorkflows(rootConfig, [rootConfig, childConfig]);
    await promisePool.promiseAll();

    const content = await fs.readFile(path.join(dirPath, '.github', 'workflows', 'test.yml'), 'utf8');
    const workflow = yaml.load(content) as ParsedWorkflow;
    const steps = workflow.jobs.test?.steps ?? [];
    const installStep = steps.find((step) => step.run === 'bun run playwright install --with-deps');
    expect(installStep?.['working-directory']).toBe('packages/app');
    const uploadStep = steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(uploadStep?.with?.path).toBe('packages/app/test-results');
  });
});

test('semantic-pr workflow grants the permissions the action needs', async () => {
  await withTempRepo(async (dirPath) => {
    const config = createConfig({
      dirPath,
      isRoot: true,
      isWillBoosterRepo: false,
      repository: 'github:someone/example',
    });
    await generateSelfContainedWorkflows(config);
    await promisePool.promiseAll();

    const content = await fs.readFile(path.join(dirPath, '.github', 'workflows', 'semantic-pr.yml'), 'utf8');
    const workflow = yaml.load(content) as {
      jobs: Record<string, { permissions?: Record<string, string> }>;
    };
    expect(workflow.jobs['semantic-pr']?.permissions).toEqual({ 'pull-requests': 'read', statuses: 'write' });
  });
});

test('treats an empty workflow file as absent', async () => {
  await withTempRepo(async (dirPath) => {
    const workflowsPath = path.join(dirPath, '.github', 'workflows');
    await fs.mkdir(workflowsPath, { recursive: true });
    await fs.writeFile(path.join(workflowsPath, 'test.yml'), '\n');

    const config = createConfig({
      dirPath,
      isRoot: true,
      isWillBoosterRepo: false,
      repository: 'github:someone/example',
    });
    await generateSelfContainedWorkflows(config);
    await promisePool.promiseAll();

    const content = await fs.readFile(path.join(workflowsPath, 'test.yml'), 'utf8');
    expect(content.startsWith(selfContainedWorkflowMarker)).toBe(true);
  });
});

test('never overwrites a hand-written workflow and regenerates a marked one', async () => {
  await withTempRepo(async (dirPath) => {
    const workflowsPath = path.join(dirPath, '.github', 'workflows');
    await fs.mkdir(workflowsPath, { recursive: true });
    const handWritten = 'name: Custom Test\non:\n  push:\njobs:\n  custom: {}\n';
    await fs.writeFile(path.join(workflowsPath, 'test.yml'), handWritten);
    await fs.writeFile(
      path.join(workflowsPath, 'semantic-pr.yml'),
      `${selfContainedWorkflowMarker} stale header\nname: Stale\njobs: {}\n`
    );

    const config = createConfig({
      dirPath,
      isRoot: true,
      isWillBoosterRepo: false,
      repository: 'github:someone/example',
    });
    await generateSelfContainedWorkflows(config);
    await promisePool.promiseAll();

    expect(await fs.readFile(path.join(workflowsPath, 'test.yml'), 'utf8')).toBe(handWritten);
    const regenerated = await fs.readFile(path.join(workflowsPath, 'semantic-pr.yml'), 'utf8');
    expect(regenerated).toContain('amannn/action-semantic-pull-request');
    expect(regenerated).not.toContain('Stale');
  });
});

async function withTempRepo(runTest: (dirPath: string) => Promise<void>): Promise<void> {
  const dirPath = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wbfy-self-contained-workflow-')));
  try {
    await runTest(dirPath);
  } finally {
    await fs.rm(dirPath, { force: true, recursive: true });
  }
}
