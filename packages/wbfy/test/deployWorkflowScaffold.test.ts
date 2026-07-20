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
    for (const script of [
      'bun wb deploy -w packages/api',
      'bun wb deploy --working-dir packages/api',
      'bun wb deploy -w=packages/api',
      'bun wb deploy -w "packages/api"',
      'bun wb -w packages/api deploy',
      'bun run --filter web build -w ignored && bun wb deploy -w packages/api',
      'bun wb deploy -w ./packages/api/',
      'bun wb -wpackages/api deploy',
      // A real deploy on the line after an inline comment must be found (comment ends its segment).
      'echo preparing # comment\nbun wb deploy -w packages/api',
      // Backslash-newline is a shell line continuation, so the two lines form one `wb deploy`.
      'bun wb \\\ndeploy -w packages/api',
      // A subshell group still runs wb deploy.
      '(bun wb deploy -w packages/api)',
      // Backslash-newline inside double quotes is also a line continuation.
      'bun wb deploy -w "packages/\\\napi"',
      // A leading `env` launcher with assignments precedes the real command.
      'env WB_ENV=production bun wb deploy -w packages/api',
      // The `command` builtin launcher.
      'command bun wb deploy -w packages/api',
    ]) {
      const parsed = generateCloudflareDeployWorkflow(createConfig(dirPath, script) as PackageConfig);
      expect(parsed?.jobs.deploy?.with?.file_path_1).toBe('packages/api/.env.cloudflare');
    }
    // Quoted or commented-out operators/text, and a package SCRIPT named wb, must NOT be read as a
    // live wb-binary deploy invocation.
    for (const script of [
      'echo "; wb deploy ;"',
      'echo prep # wb deploy -w packages/api',
      'wb prisma deploy',
      'npm run wb deploy',
      'bun run wb -- deploy',
      'yarn run wb deploy',
      'npm wb deploy',
      // `bun --cwd wb deploy` runs `deploy` in directory `wb`, not the wb binary.
      'bun --cwd wb deploy',
      // A heredoc body is data, not a command.
      "cat <<'EOF'\nbun wb deploy\nEOF",
      // `command -v`/`-V` only query availability; they do not run wb.
      'command -v wb deploy',
      'command -V wb deploy',
      // `npx -p wb deploy` runs the `deploy` binary from package `wb`, not `wb deploy`.
      'npx -p wb deploy',
    ]) {
      expect(generateCloudflareDeployWorkflow(createConfig(dirPath, script) as PackageConfig)).toBeUndefined();
    }
    // Only the config wb deploy selects contributes server_url: a stale wrangler.json sibling
    // must not leak its route past a route-less wrangler.jsonc.
    await fs.promises.writeFile(
      path.join(workerDirPath, 'wrangler.json'),
      '{ "routes": [{ "pattern": "stale.example.com", "custom_domain": true }] }'
    );
    await fs.promises.writeFile(path.join(workerDirPath, 'wrangler.jsonc'), '{ "name": "app" }');
    expect(
      generateCloudflareDeployWorkflow(createConfig(dirPath, 'bun wb deploy -w packages/api') as PackageConfig)?.jobs
        .deploy?.with?.server_url
    ).toBeUndefined();
    await fs.promises.rm(path.join(workerDirPath, 'wrangler.json'));
    // A singular `route` object works too.
    await fs.promises.writeFile(
      path.join(workerDirPath, 'wrangler.jsonc'),
      '{ "route": { "pattern": "single.example.com", "custom_domain": true } }'
    );
    expect(
      generateCloudflareDeployWorkflow(createConfig(dirPath, 'bun wb deploy -w packages/api') as PackageConfig)?.jobs
        .deploy?.with?.server_url
    ).toBe('https://single.example.com/');
    // An env.production section is authoritative (routes are non-inheritable): with the section
    // present but declaring no routes, the top-level route must NOT leak into server_url.
    await fs.promises.writeFile(
      path.join(workerDirPath, 'wrangler.jsonc'),
      '{ "routes": [{ "pattern": "base.example.com", "custom_domain": true }], "env": { "production": { "vars": {} } } }'
    );
    expect(
      generateCloudflareDeployWorkflow(createConfig(dirPath, 'bun wb deploy -w packages/api') as PackageConfig)?.jobs
        .deploy?.with?.server_url
    ).toBeUndefined();
    // env.production routes take precedence over top-level routes, matching wb deploy.
    await fs.promises.writeFile(
      path.join(workerDirPath, 'wrangler.jsonc'),
      '{ "routes": [{ "pattern": "base.example.com", "custom_domain": true }], "env": { "production": { "routes": [{ "pattern": "api.example.com", "custom_domain": true }] } } }'
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

    // wb deploy does not support TOML configs, so a TOML-only target scaffolds nothing.
    await fs.promises.writeFile(path.join(dirPath, 'wrangler.toml'), 'name = "app"\n');
    expect(generateCloudflareDeployWorkflow(createConfig(dirPath, 'wb deploy') as PackageConfig)).toBeUndefined();

    await fs.promises.writeFile(path.join(dirPath, 'wrangler.json'), '{ "name": "app" }');
    const workflow = generateCloudflareDeployWorkflow(createConfig(dirPath, 'wb deploy') as PackageConfig);
    expect(workflow?.jobs.deploy?.with).toEqual({ environment: 'production', file_path_1: '.env.cloudflare' });

    expect(generateCloudflareDeployWorkflow(createConfig(dirPath, 'railway up') as PackageConfig)).toBeUndefined();
    // `wb` must be an actual command token, not a word inside another command's arguments.
    expect(generateCloudflareDeployWorkflow(createConfig(dirPath, 'echo wb deploy') as PackageConfig)).toBeUndefined();
    expect(
      generateCloudflareDeployWorkflow(
        createConfig(dirPath, 'cross-env NOTE=wb node scripts/deploy.js --label deploy') as PackageConfig
      )
    ).toBeUndefined();
    // A worker outside the root/packages/apps layouts is not scaffolded (secret verification
    // would not cover its CLOUDFLARE_API_TOKEN).
    const nestedDirPath = path.join(dirPath, 'services', 'worker');
    await fs.promises.mkdir(nestedDirPath, { recursive: true });
    await fs.promises.writeFile(path.join(nestedDirPath, 'wrangler.json'), '{ "name": "app" }');
    expect(
      generateCloudflareDeployWorkflow(createConfig(dirPath, 'wb deploy -w services/worker') as PackageConfig)
    ).toBeUndefined();
    expect(generateCloudflareDeployWorkflow(createConfig(dirPath, undefined) as PackageConfig)).toBeUndefined();
  } finally {
    await fs.promises.rm(dirPath, { force: true, recursive: true });
  }
});
