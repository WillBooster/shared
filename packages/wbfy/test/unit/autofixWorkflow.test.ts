import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

import type { PackageConfig } from '../../src/packageConfig.js';

import { generateWorkflows } from '../../src/generators/workflow.js';
import { promisePool } from '../../src/utils/promisePool.js';
import { createConfig } from '../helpers/testConfig.js';

// Every automated fix-application path is retired: the App-based autofix-apply flow and
// autofix.ci both committed CI-generated changes with a bot credential. Their callers must be
// REMOVED rather than merely left ungenerated, or repositories keep running them.

test('generates no autofix workflow and deletes existing ones, whatever the visibility', async () => {
  for (const isPublicRepo of [true, false]) {
    const dirPath = await generateInto({ isPublicRepo }, ['autofix.yml', 'autofix-apply.yml']);
    try {
      const workflowsPath = path.join(dirPath, '.github', 'workflows');
      expect(fs.existsSync(path.join(workflowsPath, 'autofix.yml'))).toBe(false);
      expect(fs.existsSync(path.join(workflowsPath, 'autofix-apply.yml'))).toBe(false);
      // The rest of the mandatory set is unaffected.
      expect(fs.existsSync(path.join(workflowsPath, 'test.yml'))).toBe(true);
    } finally {
      await fs.promises.rm(dirPath, { recursive: true, force: true });
    }
  }
});

// Unlike the visibility-dependent generation this replaced, the removal needs no GitHub lookup,
// so a failed one must not leave a retired workflow behind.
test('deletes the retired workflows even when the repository visibility is unknown', async () => {
  const dirPath = await generateInto({ isPublicRepo: false, isRepoVisibilityKnown: false }, [
    'autofix.yml',
    'autofix-apply.yml',
  ]);
  try {
    const workflowsPath = path.join(dirPath, '.github', 'workflows');
    expect(fs.existsSync(path.join(workflowsPath, 'autofix.yml'))).toBe(false);
    expect(fs.existsSync(path.join(workflowsPath, 'autofix-apply.yml'))).toBe(false);
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
