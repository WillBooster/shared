import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { YAML } from 'bun';

import { generateWorkflows } from '../../src/generators/workflow.js';
import { withTempWorkflowsRepo } from '../helpers/callerWorkflow.js';
import { createConfig } from '../helpers/testConfig.js';

test('replaces pull_request_target with pull_request in a semantic-pr caller and keeps other triggers', async () => {
  await withTempWorkflowsRepo('wbfy-workflow-triggers-', async (dirPath, workflowsPath) => {
    fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify({ name: 'example' }));
    const filePath = path.join(workflowsPath, 'semantic-pr.yml');
    fs.writeFileSync(
      filePath,
      `name: Lint PR title\non:\n  pull_request_target:\n    types: [opened, edited, synchronize]\n  push:\n    branches: [main]\njobs:\n  semantic-pr:\n    uses: WillBooster/reusable-workflows/.github/workflows/semantic-pr.yml@main\n`
    );

    await generateWorkflows(createConfig({ dirPath, isRoot: true }));

    const workflow = YAML.parse(fs.readFileSync(filePath, 'utf8')) as { on: unknown };
    expect(workflow.on).toEqual({
      pull_request: { types: ['opened', 'edited', 'synchronize'] },
      push: { branches: ['main'] },
    });
  });
});
