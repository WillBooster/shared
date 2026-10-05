import fs from 'node:fs';
import path from 'node:path';

import { YAML } from 'bun';
import { expect, test } from 'bun:test';
import { z } from 'zod';

import { generateWorkflows } from '../../src/generators/workflow.js';
import { withTempWorkflowsRepo } from '../helpers/callerWorkflow.js';
import { createConfig } from '../helpers/testConfig.js';

const workflowSchema = z.object({
  jobs: z.record(
    z.string(),
    z.object({
      uses: z.string(),
      secrets: z.union([z.literal('inherit'), z.record(z.string(), z.string())]),
    })
  ),
});

test.each(['main', 'v1.2.3', '0123456789abcdef0123456789abcdef01234567'])(
  'regeneration preserves release caller settings at %s',
  async (ref) => {
    await withTempWorkflowsRepo('wbfy-release-preservation-', async (dirPath, workflowsPath) => {
      const filePath = path.join(workflowsPath, 'release.yml');
      const source = `name: Release
on:
  push:
    branches: [main]
jobs:
  release:
    uses: WillBooster/reusable-workflows/.github/workflows/release.yml@${ref}
    secrets:
      DISCORD_WEBHOOK_URL: \${{ secrets.PROJECT_RELEASE_WEBHOOK }}
  inherited:
    uses: WillBooster/reusable-workflows/.github/workflows/release.yml@main
    secrets: inherit
  disabled:
    uses: WillBooster/reusable-workflows/.github/workflows/release.yml@main
    secrets:
      DISCORD_WEBHOOK_URL: ''
`;
      fs.writeFileSync(filePath, source);
      const original = workflowSchema.parse(YAML.parse(source));
      const config = createConfig({ dirPath, isRoot: true });
      config.release.branches = ['main'];

      await generateWorkflows(config);
      const content = fs.readFileSync(filePath, 'utf8');
      const generated = workflowSchema.parse(YAML.parse(content));
      expect(generated.jobs).toMatchObject(original.jobs);

      await generateWorkflows(config);
      expect(fs.readFileSync(filePath, 'utf8')).toBe(content);
    });
  }
);
