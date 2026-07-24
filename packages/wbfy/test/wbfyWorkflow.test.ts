import fs from 'node:fs';
import path from 'node:path';

import { load as loadYaml } from 'js-yaml';
import { expect, test } from 'vitest';

import {
  generateWorkflows,
  getWbfyWorkflowCron,
  isWbfyWorkflowDenied,
  wbfyWorkflowDenyList,
} from '../src/generators/workflow.js';
import { promisePool } from '../src/utils/promisePool.js';
import { createConfig } from './testConfig.js';

interface WbfyCallerWorkflow {
  name?: string;
  on?: { schedule?: { cron: string }[]; workflow_dispatch?: null };
  permissions?: Record<string, string>;
  jobs: Record<string, { uses?: string; with?: Record<string, unknown>; secrets?: Record<string, string> }>;
}

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

async function loadWbfyCaller(workflowsPath: string): Promise<WbfyCallerWorkflow> {
  const content = await fs.promises.readFile(path.join(workflowsPath, 'wbfy.yml'), 'utf8');
  return loadYaml(content) as WbfyCallerWorkflow;
}

test('generates a scheduled self-applying wbfy caller for a public repository', async () => {
  await withTempRepo(async (dirPath, workflowsPath) => {
    const config = createConfig({ dirPath, isRoot: true });
    await generateWorkflows(config);
    await promisePool.promiseAll();

    const workflow = await loadWbfyCaller(workflowsPath);
    expect(workflow.name).toBe('Willboosterify');
    expect(workflow.on?.schedule).toEqual([{ cron: getWbfyWorkflowCron('github:WillBooster/example') }]);
    // oxlint-disable-next-line unicorn/no-null -- GitHub Actions valueless events are YAML nulls.
    expect(workflow.on?.workflow_dispatch).toBeNull();
    expect(workflow.permissions).toEqual({ contents: 'read' });
    const job = workflow.jobs.wbfy;
    expect(job?.uses).toBe('WillBooster/reusable-workflows/.github/workflows/wbfy.yml@main');
    expect(job?.secrets).toEqual({
      VERDACCIO_TOKEN: '${{ secrets.VERDACCIO_TOKEN }}',
      WBFY_GH_TOKEN: '${{ secrets.WBFY_GH_TOKEN }}',
    });
    // The runner-selection idiom sees github.event.repository.private as true on schedule events,
    // so a public repository must pin the GitHub-hosted runner explicitly.
    expect(job?.with).toEqual({ github_hosted_runner: true });
  });
});

test('generates a self-hosted wbfy caller for a private WillBoosterLab repository', async () => {
  await withTempRepo(async (dirPath, workflowsPath) => {
    const config = createConfig({
      dirPath,
      isRoot: true,
      isPublicRepo: false,
      repository: 'github:WillBoosterLab/example',
    });
    await generateWorkflows(config);
    await promisePool.promiseAll();

    const workflow = await loadWbfyCaller(workflowsPath);
    const job = workflow.jobs.wbfy;
    expect(job?.uses).toBe('WillBoosterLab/reusable-workflows/.github/workflows/wbfy.yml@main');
    expect(job?.with).toBeUndefined();
  });
});

test('rewrites a stale cron and drops leftover NPM_TOKEN / deprecated GH_BOT_PAT in an existing caller', async () => {
  await withTempRepo(async (dirPath, workflowsPath) => {
    await fs.promises.writeFile(
      path.join(workflowsPath, 'wbfy.yml'),
      `name: Willboosterify
on:
  schedule:
    - cron: 59 23 * * *
  workflow_dispatch:
jobs:
  wbfy:
    uses: WillBooster/reusable-workflows/.github/workflows/wbfy.yml@main
    secrets:
      NPM_TOKEN: \${{ secrets.NPM_TOKEN }}
      GH_BOT_PAT: \${{ secrets.GH_BOT_PAT }}
`
    );
    const config = createConfig({ dirPath, isRoot: true });
    await generateWorkflows(config);
    await promisePool.promiseAll();

    const workflow = await loadWbfyCaller(workflowsPath);
    expect(workflow.on?.schedule).toEqual([{ cron: getWbfyWorkflowCron('github:WillBooster/example') }]);
    expect(workflow.jobs.wbfy?.secrets).toEqual({
      VERDACCIO_TOKEN: '${{ secrets.VERDACCIO_TOKEN }}',
      WBFY_GH_TOKEN: '${{ secrets.WBFY_GH_TOKEN }}',
    });
  });
});

test('deletes the generated caller from a deny-listed repository but keeps a custom same-named workflow', async () => {
  await withTempRepo(async (dirPath, workflowsPath) => {
    await fs.promises.writeFile(
      path.join(workflowsPath, 'wbfy.yml'),
      `on: workflow_dispatch
jobs:
  wbfy:
    uses: WillBooster/reusable-workflows/.github/workflows/wbfy.yml@main
`
    );
    const config = createConfig({ dirPath, isRoot: true, repository: 'github:WillBooster/verdaccio' });
    await generateWorkflows(config);
    await promisePool.promiseAll();
    expect(fs.existsSync(path.join(workflowsPath, 'wbfy.yml'))).toBe(false);
  });

  await withTempRepo(async (dirPath, workflowsPath) => {
    const customContent = `on: workflow_dispatch
jobs:
  custom:
    runs-on: ubuntu-latest
    steps:
      - run: echo not a wbfy caller
`;
    await fs.promises.writeFile(path.join(workflowsPath, 'wbfy.yml'), customContent);
    const config = createConfig({ dirPath, isRoot: true, repository: 'github:WillBooster/verdaccio' });
    await generateWorkflows(config);
    await promisePool.promiseAll();
    expect(await fs.promises.readFile(path.join(workflowsPath, 'wbfy.yml'), 'utf8')).toBe(customContent);
  });
});

test('skips generating (but does not delete) the caller when the repository visibility is unknown', async () => {
  await withTempRepo(async (dirPath, workflowsPath) => {
    const config = createConfig({ dirPath, isRoot: true, isPublicRepo: false, isRepoVisibilityKnown: false });
    await generateWorkflows(config);
    await promisePool.promiseAll();
    // A failed GitHub lookup collapses isPublicRepo to false; generating from that state would
    // schedule a possibly-public repository onto the self-hosted runners.
    expect(fs.existsSync(path.join(workflowsPath, 'wbfy.yml'))).toBe(false);
  });

  await withTempRepo(async (dirPath, workflowsPath) => {
    const existingContent = `on: workflow_dispatch
jobs:
  wbfy:
    uses: WillBooster/reusable-workflows/.github/workflows/wbfy.yml@main
`;
    await fs.promises.writeFile(path.join(workflowsPath, 'wbfy.yml'), existingContent);
    const config = createConfig({ dirPath, isRoot: true, isPublicRepo: false, isRepoVisibilityKnown: false });
    await generateWorkflows(config);
    await promisePool.promiseAll();
    expect(await fs.promises.readFile(path.join(workflowsPath, 'wbfy.yml'), 'utf8')).toBe(existingContent);
  });
});

test('deny list decisions are case-insensitive and cover unknown repositories', () => {
  expect(isWbfyWorkflowDenied('github:WillBooster/self-host-utils')).toBe(true);
  expect(isWbfyWorkflowDenied('github:WillBoosterLab/Seamzip')).toBe(true);
  expect(isWbfyWorkflowDenied('github:WillBooster/shared')).toBe(false);
  expect(isWbfyWorkflowDenied(undefined)).toBe(true);
  // Guard against accidental emptying: the deny list must keep covering the known-unsupported repos.
  expect(wbfyWorkflowDenyList.has('reusable-workflows')).toBe(true);
});

test('the staggered cron is deterministic, case-insensitive, and stays within the safe window', () => {
  const cron = getWbfyWorkflowCron('github:WillBooster/example');
  expect(cron).toBe(getWbfyWorkflowCron('github:willbooster/EXAMPLE'));
  // Different repositories should usually get different slots (spot-check two known names).
  expect(getWbfyWorkflowCron('github:WillBooster/shared')).not.toBe(getWbfyWorkflowCron('github:WillBooster/judge'));
  // Every slot must start between 16:00 and 17:59 UTC: with the 30-minute job timeout, the run
  // finishes by 18:29 UTC, keeping ~30 minutes of schedule-delay slack before the 19:00 UTC
  // (04:00 JST) self-hosted Ubuntu runner reboot, and always before the 20:00 UTC wbfy-merge run.
  for (const seed of ['example', 'shared', 'judge', 'exercode', 'a', 'zz', 'agentic-workflows', 'website']) {
    const match = /^(\d{1,2}) (\d{2}) \* \* \*$/.exec(getWbfyWorkflowCron(`github:WillBooster/${seed}`));
    expect(match, seed).not.toBeNull();
    const minute = Number(match![1]);
    const hour = Number(match![2]);
    expect(minute).toBeGreaterThanOrEqual(0);
    expect(minute).toBeLessThan(60);
    expect(hour).toBeGreaterThanOrEqual(16);
    expect(hour * 60 + minute).toBeLessThanOrEqual(17 * 60 + 59);
  }
});
