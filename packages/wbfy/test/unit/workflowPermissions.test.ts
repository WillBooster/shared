import fs from 'node:fs';
import path from 'node:path';

import { YAML } from 'bun';
import { expect, test } from 'bun:test';

import { generateWorkflows } from '../../src/generators/workflow.js';
import { promisePool } from '../../src/utils/promisePool.js';
import { withTempWorkflowsRepo } from '../helpers/callerWorkflow.js';
import { createConfig } from '../helpers/testConfig.js';

test('generated callers grant only the permissions required by their reusable workflows', async () => {
  await withTempWorkflowsRepo('wbfy-workflow-permissions-', async (dirPath, workflowsPath) => {
    fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify({ name: 'example' }));

    await generateWorkflows(createConfig({ dirPath, isRoot: true, cargoTomlDirPaths: ['native'] }));
    await promisePool.promiseAll();

    expect(readPermissions(workflowsPath, 'test-rust.yml')).toEqual({ contents: 'read' });
    expect(readPermissions(workflowsPath, 'semantic-pr.yml')).toEqual({
      'pull-requests': 'read',
      statuses: 'write',
    });
    expect(readPermissions(workflowsPath, 'close-comment.yml')).toEqual({ 'pull-requests': 'write' });
  });
});

function readPermissions(workflowsPath: string, fileName: string): Record<string, string> | undefined {
  const workflow = YAML.parse(fs.readFileSync(path.join(workflowsPath, fileName), 'utf8')) as {
    permissions?: Record<string, string>;
  };
  return workflow.permissions;
}
