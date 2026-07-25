import fs from 'node:fs';
import path from 'node:path';

import { load as loadYaml } from 'js-yaml';
import { expect, test } from 'vitest';

import type { PackageConfig } from '../../src/packageConfig.js';

import { generateWorkflows } from '../../src/generators/workflow.js';
import { promisePool } from '../../src/utils/promisePool.js';
import { createConfig } from '../helpers/testConfig.js';

test('generates a public autofix workflow that can run wb with fnox on CI', async () => {
  const tempRootPath = path.join(process.cwd(), '.tmp');
  await fs.promises.mkdir(tempRootPath, { recursive: true });
  const dirPath = await fs.promises.mkdtemp(path.join(tempRootPath, 'wbfy-autofix-'));
  try {
    await fs.promises.mkdir(path.join(dirPath, '.github', 'workflows'), { recursive: true });
    const config = createConfig({
      dirPath,
      isRoot: true,
      packageJson: { scripts: { build: 'wb build' } },
    });
    await generateWorkflows(config);
    await promisePool.promiseAll();

    const content = await fs.promises.readFile(path.join(dirPath, '.github', 'workflows', 'autofix.yml'), 'utf8');
    const workflow = loadYaml(content) as { jobs: { autofix: { env?: Record<string, string>; steps?: unknown[] } } };
    expect(workflow.jobs.autofix.env).toEqual({ WB_ENV: 'development' });
    expect(workflow.jobs.autofix.steps).toContainEqual({ uses: 'jdx/mise-action@v4.2.0', with: { cache: true } });
  } finally {
    await fs.promises.rm(dirPath, { recursive: true, force: true });
  }
});

// The two autofix paths are mutually exclusive and chosen purely by repository visibility, which
// nothing else in the build can check: a wrong choice silently leaves a repository with no working
// autofix (or, worse, a public repository calling the private App-based one).
test('a private repository gets the App-based apply workflow instead of autofix.ci', async () => {
  // Seeded so the assertion below proves the obsolete workflow is DELETED, not merely skipped.
  const dirPath = await generateInto({ isPublicRepo: false }, ['autofix.yml']);
  try {
    const workflowsPath = path.join(dirPath, '.github', 'workflows');
    expect(fs.existsSync(path.join(workflowsPath, 'autofix.yml'))).toBe(false);

    const content = await fs.promises.readFile(path.join(workflowsPath, 'autofix-apply.yml'), 'utf8');
    const workflow = loadYaml(content) as {
      on: { workflow_run: { workflows: string[]; types: string[] } };
      permissions: Record<string, string>;
      jobs: { apply: { uses: string; secrets: Record<string, string> } };
    };
    expect(workflow.on.workflow_run).toEqual({ workflows: ['Test'], types: ['completed'] });
    // A called workflow can only reduce the caller's token, so actions:read must be granted here
    // or the apply job cannot read the triggering run's artifact.
    expect(workflow.permissions).toEqual({ actions: 'read', contents: 'read' });
    expect(workflow.jobs.apply.uses).toBe('WillBooster/reusable-workflows/.github/workflows/autofix-apply.yml@main');
    // The App ID is a constant in the callee, so the key is the only thing a caller passes.
    expect(workflow.jobs.apply.secrets).toEqual({
      AUTOFIX_APP_PRIVATE_KEY: '${{ secrets.AUTOFIX_APP_PRIVATE_KEY }}',
    });
  } finally {
    await fs.promises.rm(dirPath, { recursive: true, force: true });
  }
});

test('a public repository keeps autofix.ci and gets no apply workflow', async () => {
  const dirPath = await generateInto({ isPublicRepo: true }, ['autofix-apply.yml']);
  try {
    const workflowsPath = path.join(dirPath, '.github', 'workflows');
    expect(fs.existsSync(path.join(workflowsPath, 'autofix.yml'))).toBe(true);
    expect(fs.existsSync(path.join(workflowsPath, 'autofix-apply.yml'))).toBe(false);
  } finally {
    await fs.promises.rm(dirPath, { recursive: true, force: true });
  }
});

test("the test caller keeps the permissions the reusable workflow's other steps still need", async () => {
  const dirPath = await generateInto({ isPublicRepo: false });
  try {
    const content = await fs.promises.readFile(path.join(dirPath, '.github', 'workflows', 'test.yml'), 'utf8');
    const workflow = loadYaml(content) as { permissions: Record<string, string>; on: Record<string, unknown> };
    // contents:write for semantic-release's unconditional push check, actions:write for the test
    // job's skip-duplicate-actions cancel_others. Dropping either because "test.yml no longer
    // pushes" breaks callers.
    expect(workflow.permissions).toMatchObject({ actions: 'write', contents: 'write', statuses: 'write' });
    expect(workflow.on).toHaveProperty('workflow_dispatch');
  } finally {
    await fs.promises.rm(dirPath, { recursive: true, force: true });
  }
});

// A failed GitHub lookup collapses isPublicRepo to false. Because this branch both deletes one
// workflow and creates the other, guessing "private" would strip a public repository's autofix.ci
// setup and hand it the App-based workflow that refuses fork pull requests.
test('unknown repository visibility leaves existing autofix workflows byte-identical', async () => {
  const dirPath = await generateInto({ isPublicRepo: true });
  try {
    const workflowsPath = path.join(dirPath, '.github', 'workflows');
    const publicAutofix = await fs.promises.readFile(path.join(workflowsPath, 'autofix.yml'), 'utf8');
    // Sentinel content rather than a generated file: only an untouched file stays unequal to what
    // the generator would have written, which is what proves nothing deleted or rewrote it.
    const sentinel = 'name: Sentinel\non: push\njobs: {}\n';
    await fs.promises.writeFile(path.join(workflowsPath, 'autofix-apply.yml'), sentinel);

    // Exactly what getPackageConfig produces for a public repository whose lookup failed.
    await generateWorkflows(createConfig({ dirPath, isRoot: true, isPublicRepo: false, isRepoVisibilityKnown: false }));
    await promisePool.promiseAll();

    expect(await fs.promises.readFile(path.join(workflowsPath, 'autofix.yml'), 'utf8')).toBe(publicAutofix);
    expect(await fs.promises.readFile(path.join(workflowsPath, 'autofix-apply.yml'), 'utf8')).toBe(sentinel);
  } finally {
    await fs.promises.rm(dirPath, { recursive: true, force: true });
  }
});

test('unknown repository visibility creates neither autofix workflow from scratch', async () => {
  const dirPath = await generateInto({ isPublicRepo: false, isRepoVisibilityKnown: false });
  try {
    const workflowsPath = path.join(dirPath, '.github', 'workflows');
    // Guessing either way would commit a workflow the repository may not be allowed to have.
    expect(fs.existsSync(path.join(workflowsPath, 'autofix.yml'))).toBe(false);
    expect(fs.existsSync(path.join(workflowsPath, 'autofix-apply.yml'))).toBe(false);
    // The rest of the mandatory set is unaffected by the visibility guard.
    expect(fs.existsSync(path.join(workflowsPath, 'test.yml'))).toBe(true);
  } finally {
    await fs.promises.rm(dirPath, { recursive: true, force: true });
  }
});

/**
 * `seedFileNames` are written before generating. Without them an "is absent afterwards" assertion
 * passes on a file that was simply never created, which would leave the removal itself untested.
 */
async function generateInto(overrides: Partial<PackageConfig>, seedFileNames: string[] = []): Promise<string> {
  const tempRootPath = path.join(process.cwd(), '.tmp');
  await fs.promises.mkdir(tempRootPath, { recursive: true });
  const dirPath = await fs.promises.mkdtemp(path.join(tempRootPath, 'wbfy-autofix-'));
  const workflowsPath = path.join(dirPath, '.github', 'workflows');
  await fs.promises.mkdir(workflowsPath, { recursive: true });
  for (const fileName of seedFileNames) {
    await fs.promises.writeFile(path.join(workflowsPath, fileName), 'name: Seeded\non: push\njobs: {}\n');
  }
  await generateWorkflows(createConfig({ dirPath, isRoot: true, ...overrides }));
  await promisePool.promiseAll();
  return dirPath;
}
