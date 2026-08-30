import fs from 'node:fs';
import path from 'node:path';

import { YAML } from 'bun';
import { expect, test } from 'bun:test';
import { z } from 'zod';

import { generateWorkflows } from '../../src/generators/workflow.js';
import { promisePool } from '../../src/utils/promisePool.js';
import { withTempWorkflowsRepo } from '../helpers/callerWorkflow.js';
import { createConfig } from '../helpers/testConfig.js';

const workflowSchema = z.object({
  permissions: z.record(z.string(), z.string()).optional(),
  jobs: z.record(
    z.string(),
    z.object({
      permissions: z.record(z.string(), z.string()).optional(),
      'runs-on': z.string().optional(),
      steps: z.array(z.object({ run: z.string() })).optional(),
    })
  ),
});

test('generated callers scope permissions without changing preserved sibling jobs', async () => {
  await withTempWorkflowsRepo('wbfy-workflow-permissions-', async (dirPath, workflowsPath) => {
    fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify({ name: 'example' }));
    for (const workflowName of ['test-rust', 'semantic-pr', 'close-comment']) {
      fs.writeFileSync(
        path.join(workflowsPath, `${workflowName}.yml`),
        `jobs:\n  ${workflowName}:\n    permissions:\n      contents: write\n    uses: WillBooster/reusable-workflows/.github/workflows/${workflowName}.yml@main\n  sibling:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo preserved\n`
      );
    }
    fs.writeFileSync(
      path.join(workflowsPath, 'custom.yml'),
      `jobs:\n  rust:\n    permissions:\n      contents: write\n    uses: WillBooster/reusable-workflows/.github/workflows/test-rust.yml@main\n  pr:\n    permissions:\n      contents: write\n    uses: WillBooster/reusable-workflows/.github/workflows/semantic-pr.yml@main\n  comment:\n    permissions:\n      contents: write\n    uses: WillBooster/reusable-workflows/.github/workflows/close-comment.yml@main\n`
    );

    await generateWorkflows(createConfig({ dirPath, isRoot: true, cargoTomlDirPaths: ['native'] }));
    await promisePool.promiseAll();

    expect(readPermissions(workflowsPath, 'test-rust.yml')).toEqual({
      actions: 'read',
      contents: 'read',
    });
    expect(readPermissions(workflowsPath, 'semantic-pr.yml')).toEqual({
      'pull-requests': 'read',
      statuses: 'write',
    });
    expect(readPermissions(workflowsPath, 'close-comment.yml')).toEqual({ 'pull-requests': 'write' });
    const customWorkflow = readWorkflow(workflowsPath, 'custom.yml');
    expect(customWorkflow.jobs.rust?.permissions).toEqual({ actions: 'read', contents: 'read' });
    expect(customWorkflow.jobs.pr?.permissions).toEqual({ 'pull-requests': 'read', statuses: 'write' });
    expect(customWorkflow.jobs.comment?.permissions).toEqual({ 'pull-requests': 'write' });
  });
});

function readPermissions(workflowsPath: string, fileName: string): Record<string, string> | undefined {
  const workflow = readWorkflow(workflowsPath, fileName);
  expect(workflow.permissions).toBeUndefined();
  expect(workflow.jobs.sibling).toEqual({
    'runs-on': 'ubuntu-latest',
    steps: [{ run: 'echo preserved' }],
  });
  const callerName = fileName.slice(0, -'.yml'.length);
  return workflow.jobs[callerName]?.permissions;
}

function readWorkflow(workflowsPath: string, fileName: string): z.infer<typeof workflowSchema> {
  return workflowSchema.parse(YAML.parse(fs.readFileSync(path.join(workflowsPath, fileName), 'utf8')));
}
