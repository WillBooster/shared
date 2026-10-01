import fs from 'node:fs/promises';
import path from 'node:path';

import { YAML } from 'bun';
import { expect, test } from 'bun:test';
import { z } from 'zod';

import {
  generateSelfContainedWorkflows,
  selfContainedWorkflowMarker,
} from '../../src/generators/selfContainedWorkflow.js';
import { generateWorkflows } from '../../src/generators/workflow.js';
import { withTempWorkflowsRepo } from '../helpers/callerWorkflow.js';
import { createConfig } from '../helpers/testConfig.js';

const pushSchema = z.object({
  branches: z.array(z.string()),
  paths: z.array(z.string()).optional(),
  'paths-ignore': z.array(z.string()).optional(),
});
const workflowSchema = z.object({ on: z.object({ push: pushSchema }) });

for (const standalone of [false, true]) {
  test(`${standalone ? 'standalone' : 'reusable'} deploy updates preserve edited push filters across repeated generation`, async () => {
    await withTempWorkflowsRepo('wbfy-deploy-paths-', async (dirPath, workflowsPath) => {
      const filePath = path.join(workflowsPath, 'deploy-staging.yml');
      const config = createConfig({
        dirPath,
        isRoot: true,
        isWillBoosterRepo: !standalone,
        repository: standalone ? 'github:someone/example' : 'github:WillBooster/example',
        packageJson: { scripts: { 'deploy:staging': 'WB_ENV=staging bun wb deploy' } },
      });
      const generate = standalone ? generateSelfContainedWorkflows : generateWorkflows;
      await (standalone
        ? generate(config)
        : fs.writeFile(
            filePath,
            `name: Deploy staging\non:\n  push:\n    branches: [main]\n    paths-ignore: ['**.md', '**/docs/**']\njobs:\n  deploy:\n    uses: WillBooster/reusable-workflows/.github/workflows/deploy.yml@main\n    with:\n      environment: staging\n`
          ));

      const workflow = z.record(z.string(), z.unknown()).parse(YAML.parse(await fs.readFile(filePath, 'utf8')));
      const header = standalone ? `${selfContainedWorkflowMarker}\n` : '';
      for (const filters of [{}, { 'paths-ignore': [] }, { 'paths-ignore': ['assets/**'] }, { paths: ['docs/**'] }]) {
        const push = { branches: ['main'], ...filters };
        workflow.on = { push };
        await fs.writeFile(filePath, header + YAML.stringify(workflow));

        for (let iteration = 0; iteration < 2; iteration++) {
          await generate(config);
          const output = workflowSchema.parse(YAML.parse(await fs.readFile(filePath, 'utf8')));
          expect(output.on.push).toEqual(push);
        }
      }
    });
  });
}

test('empty standalone deploy workflows receive the same defaults as missing files', async () => {
  await withTempWorkflowsRepo('wbfy-empty-deploy-', async (dirPath, workflowsPath) => {
    const filePath = path.join(workflowsPath, 'deploy-staging.yml');
    const config = createConfig({
      dirPath,
      isRoot: true,
      isWillBoosterRepo: false,
      repository: 'github:someone/example',
      packageJson: { scripts: { 'deploy:staging': 'WB_ENV=staging bun wb deploy' } },
    });
    await generateSelfContainedWorkflows(config);
    const initial = await fs.readFile(filePath, 'utf8');
    expect(workflowSchema.parse(YAML.parse(initial)).on.push['paths-ignore']?.length).toBeGreaterThan(0);

    await fs.writeFile(filePath, ' \n\t\n');
    await generateSelfContainedWorkflows(config);
    expect(await fs.readFile(filePath, 'utf8')).toBe(initial);
  });
});
