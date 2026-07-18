import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { generateCloudflareDeployWorkflow } from '../src/generators/workflow.js';
import type { PackageConfig } from '../src/packageConfig.js';

function createConfig(
  dirPath: string,
  deployScript: string | undefined
): Pick<PackageConfig, 'dirPath' | 'packageJson'> {
  return { dirPath, packageJson: deployScript === undefined ? {} : { scripts: { deploy: deployScript } } };
}

test('scaffolds a dispatch-only production deploy caller from the deploy script and wrangler routes', async () => {
  const dirPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wbfy-deploy-scaffold-'));
  try {
    const workerDirPath = path.join(dirPath, 'packages', 'api');
    await fs.promises.mkdir(workerDirPath, { recursive: true });
    await fs.promises.writeFile(
      path.join(workerDirPath, 'wrangler.jsonc'),
      `{
  // production routes
  "routes": [{ "pattern": "api.example.com", "custom_domain": true }],
}`
    );
    const workflow = generateCloudflareDeployWorkflow(
      createConfig(dirPath, 'bun wb deploy -w packages/api') as PackageConfig
    );
    // oxlint-disable-next-line unicorn/no-null -- GitHub Actions valueless events are YAML nulls.
    expect(workflow?.on).toEqual({ workflow_dispatch: null });
    const job = workflow?.jobs.deploy;
    expect(job?.uses).toBe('WillBooster/reusable-workflows/.github/workflows/deploy.yml@main');
    expect(job?.with).toEqual({
      environment: 'production',
      file_path_1: 'packages/api/.env.cloudflare',
      server_url: 'https://api.example.com/',
    });
  } finally {
    await fs.promises.rm(dirPath, { force: true, recursive: true });
  }
});

test('scaffolds a root-level worker without a custom domain and skips non-wb deploy scripts', async () => {
  const dirPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wbfy-deploy-scaffold-root-'));
  try {
    // Without a wrangler config at the deploy target, nothing is scaffolded.
    expect(generateCloudflareDeployWorkflow(createConfig(dirPath, 'wb deploy') as PackageConfig)).toBeUndefined();

    await fs.promises.writeFile(path.join(dirPath, 'wrangler.toml'), 'name = "app"\n');
    const workflow = generateCloudflareDeployWorkflow(createConfig(dirPath, 'wb deploy') as PackageConfig);
    expect(workflow?.jobs.deploy?.with).toEqual({ environment: 'production', file_path_1: '.env.cloudflare' });

    expect(generateCloudflareDeployWorkflow(createConfig(dirPath, 'railway up') as PackageConfig)).toBeUndefined();
    expect(generateCloudflareDeployWorkflow(createConfig(dirPath, undefined) as PackageConfig)).toBeUndefined();
  } finally {
    await fs.promises.rm(dirPath, { force: true, recursive: true });
  }
});
