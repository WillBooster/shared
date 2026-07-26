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

// The App-based autofix-apply workflow is retired: committing CI-generated patches with a bot
// credential was judged a risk with little benefit, so its callers must be REMOVED everywhere,
// or the App private key could never be decommissioned.
test('a private repository gets no autofix workflow at all, and existing ones are deleted', async () => {
  const dirPath = await generateInto({ isPublicRepo: false }, ['autofix.yml', 'autofix-apply.yml']);
  try {
    const workflowsPath = path.join(dirPath, '.github', 'workflows');
    expect(fs.existsSync(path.join(workflowsPath, 'autofix.yml'))).toBe(false);
    expect(fs.existsSync(path.join(workflowsPath, 'autofix-apply.yml'))).toBe(false);
  } finally {
    await fs.promises.rm(dirPath, { recursive: true, force: true });
  }
});

test('a public repository keeps autofix.ci but loses an existing autofix-apply caller', async () => {
  const dirPath = await generateInto({ isPublicRepo: true }, ['autofix-apply.yml']);
  try {
    const workflowsPath = path.join(dirPath, '.github', 'workflows');
    expect(fs.existsSync(path.join(workflowsPath, 'autofix.yml'))).toBe(true);
    expect(fs.existsSync(path.join(workflowsPath, 'autofix-apply.yml'))).toBe(false);
  } finally {
    await fs.promises.rm(dirPath, { recursive: true, force: true });
  }
});

// A failed GitHub lookup collapses isPublicRepo to false. Deleting or creating autofix.yml from
// that state would strip a public repository's autofix.ci setup, so it must stay untouched —
// while the retired autofix-apply.yml is deleted regardless of visibility.
test('unknown repository visibility leaves autofix.yml byte-identical but still deletes autofix-apply.yml', async () => {
  const dirPath = await generateInto({ isPublicRepo: true });
  try {
    const workflowsPath = path.join(dirPath, '.github', 'workflows');
    const publicAutofix = await fs.promises.readFile(path.join(workflowsPath, 'autofix.yml'), 'utf8');
    await fs.promises.writeFile(path.join(workflowsPath, 'autofix-apply.yml'), 'name: Retired\non: push\njobs: {}\n');

    // Exactly what getPackageConfig produces for a public repository whose lookup failed.
    await generateWorkflows(createConfig({ dirPath, isRoot: true, isPublicRepo: false, isRepoVisibilityKnown: false }));
    await promisePool.promiseAll();

    expect(await fs.promises.readFile(path.join(workflowsPath, 'autofix.yml'), 'utf8')).toBe(publicAutofix);
    expect(fs.existsSync(path.join(workflowsPath, 'autofix-apply.yml'))).toBe(false);
  } finally {
    await fs.promises.rm(dirPath, { recursive: true, force: true });
  }
});

test('unknown repository visibility creates no autofix workflow from scratch', async () => {
  const dirPath = await generateInto({ isPublicRepo: false, isRepoVisibilityKnown: false });
  try {
    const workflowsPath = path.join(dirPath, '.github', 'workflows');
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
