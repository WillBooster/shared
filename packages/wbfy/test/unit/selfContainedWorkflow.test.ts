// oxlint-disable eslint-plugin-import/no-named-as-default-member -- Namespace YAML calls make load/dump usage clearer.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as yaml from 'js-yaml';
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
      env?: Record<string, string>;
      steps: {
        name?: string;
        if?: string;
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
    const installStep = steps.find((step) => step.name === 'Install dependencies');
    expect(installStep?.env?.FNOX_AGE_KEY).toBeUndefined();
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
    const secondChildConfig = createConfig({
      dirPath: path.join(dirPath, 'packages', 'web'),
      isWillBoosterRepo: false,
      repository: 'github:someone/example',
      depending: { ...createConfig().depending, playwrightTest: true },
    });
    await generateSelfContainedWorkflows(rootConfig, [rootConfig, childConfig, secondChildConfig]);
    await promisePool.promiseAll();

    const content = await fs.readFile(path.join(dirPath, '.github', 'workflows', 'test.yml'), 'utf8');
    const workflow = yaml.load(content) as ParsedWorkflow;
    const steps = workflow.jobs.test?.steps ?? [];
    // Every declaring package gets its own browser installation (versions may differ).
    const installSteps = steps.filter((step) => step.run === 'bun playwright install --with-deps');
    expect(installSteps.map((step) => step['working-directory'])).toEqual(['packages/app', 'packages/web']);
    const cacheStep = steps.find((step) => step.uses?.startsWith('actions/cache@'));
    expect(cacheStep?.with?.key).toBe(
      'playwright-${{ runner.os }}-${{ steps.playwright-version-0.outputs.version }}-${{ steps.playwright-version-1.outputs.version }}'
    );
    const uploadStep = steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(uploadStep?.with?.path).toBe('packages/app/test-results\npackages/web/test-results');
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

test('generates release and deploy workflows for wb-deploy scripts and semantic-release', async () => {
  await withTempRepo(async (dirPath) => {
    const config = createConfig({
      dirPath,
      isRoot: true,
      isWillBoosterRepo: false,
      repository: 'github:someone/example',
      depending: { ...createConfig().depending, semanticRelease: true },
      release: { branches: ['release'], github: true, npm: false, npmPublishesRoot: false },
      packageJson: {
        scripts: {
          deploy: 'WB_ENV=production bun wb deploy',
          'deploy:staging': 'WB_ENV=staging bun wb deploy',
        },
      },
    });
    await generateSelfContainedWorkflows(config);
    await promisePool.promiseAll();

    const workflowsPath = path.join(dirPath, '.github', 'workflows');
    const production = await fs.readFile(path.join(workflowsPath, 'deploy-production.yml'), 'utf8');
    expect(production).toContain('bun run deploy');
    expect(production).toContain('nick-fields/retry@');
    const staging = yaml.load(await fs.readFile(path.join(workflowsPath, 'deploy-staging.yml'), 'utf8')) as {
      on: { push?: { branches: string[] } };
    };
    expect(staging.on.push?.branches).toEqual(['main']);
    const release = await fs.readFile(path.join(workflowsPath, 'release.yml'), 'utf8');
    expect(release).toContain('semantic-release');
    expect(release).toContain('gh workflow run deploy-production.yml');
    const releaseWorkflow = yaml.load(release) as {
      on: { push: { branches: string[] } };
      jobs: { release: { env: Record<string, string> } };
    };
    expect(releaseWorkflow.on.push.branches).toEqual(['release']);
    // A release job names no environment, so wb's CI guard must be skipped; otherwise a
    // `postinstall` that calls wb exits 1 and the release never reaches semantic-release.
    expect(releaseWorkflow.jobs.release.env.WB_SKIP_ENV_CHECK).toBe('1');
  });
});

test('does not generate deploy workflows for bespoke deploy scripts', async () => {
  await withTempRepo(async (dirPath) => {
    const config = createConfig({
      dirPath,
      isRoot: true,
      isWillBoosterRepo: false,
      repository: 'github:someone/example',
      packageJson: { scripts: { deploy: 'bash scripts/deploy.sh' } },
    });
    await generateSelfContainedWorkflows(config);
    await promisePool.promiseAll();

    const workflowsPath = path.join(dirPath, '.github', 'workflows');
    await expect(fs.access(path.join(workflowsPath, 'deploy-production.yml'))).rejects.toThrow();
    await expect(fs.access(path.join(workflowsPath, 'release.yml'))).rejects.toThrow();
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

test('hardens every install with the Takumi Guard proxy without exposing the token to lifecycle scripts', async () => {
  await withTempRepo(async (dirPath) => {
    const config = createConfig({
      dirPath,
      isRoot: true,
      isWillBoosterRepo: false,
      repository: 'github:someone/example',
      depending: { ...createConfig().depending, semanticRelease: true },
      release: { branches: ['main'], github: true, npm: false, npmPublishesRoot: false },
      packageJson: { scripts: { deploy: 'WB_ENV=production bun wb deploy' } },
    });
    await generateSelfContainedWorkflows(config);
    await promisePool.promiseAll();

    const workflowsPath = path.join(dirPath, '.github', 'workflows');
    for (const fileName of ['test.yml', 'deploy-production.yml', 'release.yml']) {
      const workflow = yaml.load(await fs.readFile(path.join(workflowsPath, fileName), 'utf8')) as ParsedWorkflow;
      const job = Object.values(workflow.jobs)[0];
      // The `if:` gates read the non-secret signal, and the empty token keeps the generated
      // .npmrc's ${TAKUMI_GUARD_TOKEN} reference expandable in the tokenless steps.
      expect(job?.env?.HAS_TAKUMI_GUARD_TOKEN).toBe('${{ !!secrets.TAKUMI_GUARD_TOKEN }}');
      expect(job?.env?.TAKUMI_GUARD_TOKEN).toBe('');

      const steps = job?.steps ?? [];
      const installStep = steps.find((step) => step.name === 'Install dependencies');
      expect(installStep?.env?.TAKUMI_GUARD_TOKEN).toBe('${{ secrets.TAKUMI_GUARD_TOKEN }}');
      expect(installStep?.run).toContain('bun install --frozen-lockfile --ignore-scripts');
      // A missing bun.lock would otherwise install fresh, unpinned resolutions silently.
      expect(installStep?.run).toContain('bun.lock is missing');
      // Without the secret the very same step still installs normally.
      expect(installStep?.run).toContain('bun install --frozen-lockfile\nfi');

      // The replay runs the lifecycle scripts, so it must not carry the token.
      const replayStep = steps.find(
        (step) => step.name === 'Run dependency lifecycle scripts without registry credentials'
      );
      expect(replayStep?.env).toBeUndefined();
      expect(replayStep?.if).toBe("${{ env.HAS_TAKUMI_GUARD_TOKEN == 'true' }}");
      // Only the test workflow tolerates failing lifecycle scripts; a deploy must not silently
      // ship a tree whose lifecycle scripts (e.g. `postinstall: wb gen-code`) never ran (#1127).
      if (fileName === 'test.yml') {
        expect(replayStep?.run).toContain('::warning::');
      } else {
        expect(replayStep?.run).not.toContain('::warning::');
        expect(replayStep?.run).not.toContain('--ignore-scripts');
      }
      // Guard answers `npm publish` with 405, so the proxy must not outlive the install.
      const cleanupStep = steps.find((step) => step.name === 'Remove the generated .npmrc');
      expect(cleanupStep?.if).toBe("${{ env.HAS_TAKUMI_GUARD_TOKEN == 'true' }}");
      expect(steps.indexOf(cleanupStep!)).toBeGreaterThan(steps.indexOf(replayStep!));
    }
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
