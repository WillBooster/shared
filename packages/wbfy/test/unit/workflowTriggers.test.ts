import fs from 'node:fs';
import path from 'node:path';

import { YAML } from 'bun';
import { expect, test } from 'bun:test';

import { generateWorkflows } from '../../src/generators/workflow.js';
import { withTempWorkflowsRepo } from '../helpers/callerWorkflow.js';
import { createConfig } from '../helpers/testConfig.js';

test('regenerates a pull_request_target semantic-pr caller with the pull_request trigger only', async () => {
  await withTempWorkflowsRepo('wbfy-workflow-triggers-', async (dirPath, workflowsPath) => {
    fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify({ name: 'example' }));
    const filePath = path.join(workflowsPath, 'semantic-pr.yml');
    fs.writeFileSync(
      filePath,
      `name: Lint PR title\non:\n  pull_request_target:\n    types: [opened, edited, synchronize]\njobs:\n  semantic-pr:\n    uses: WillBooster/reusable-workflows/.github/workflows/semantic-pr.yml@main\n`
    );

    await generateWorkflows(createConfig({ dirPath, isRoot: true }));

    const workflow = YAML.parse(fs.readFileSync(filePath, 'utf8')) as { on: unknown };
    expect(workflow.on).toEqual({ pull_request: { types: ['opened', 'edited', 'synchronize'] } });
  });
});
