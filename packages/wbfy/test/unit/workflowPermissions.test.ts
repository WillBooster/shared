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
    z
      .object({
        permissions: z.record(z.string(), z.string()).optional(),
        'runs-on': z.string().optional(),
        steps: z.array(z.object({ run: z.string() })).optional(),
        with: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough()
  ),
});
const siblingJobSchema = z.strictObject({
  'runs-on': z.literal('ubuntu-latest'),
  steps: z.tuple([z.strictObject({ run: z.literal('echo preserved') })]),
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

test('private source repositories publishing to npm keep trusted-publishing permission', async () => {
  await withTempWorkflowsRepo('wbfy-workflow-npm-oidc-', async (dirPath, workflowsPath) => {
    fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify({ name: 'example' }));
    fs.writeFileSync(
      path.join(workflowsPath, 'release.yml'),
      `jobs:\n  release:\n    uses: WillBooster/reusable-workflows/.github/workflows/release.yml@main\n    with:\n      github_hosted_runner: true\n      runs_on: '["self-hosted"]'\n  sibling:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo preserved\n`
    );

    await generateWorkflows(
      createConfig({
        dirPath,
        isRoot: true,
        isPublicRepo: false,
        depending: { ...createConfig().depending, semanticRelease: true },
        release: {
          branches: ['main'],
          github: true,
          npm: true,
          npmPublishDirPaths: [dirPath],
          npmPublishesRoot: true,
        },
      })
    );
    await promisePool.promiseAll();

    const releaseWorkflow = readWorkflow(workflowsPath, 'release.yml');
    expect(releaseWorkflow.permissions).toEqual({ contents: 'write' });
    expect(releaseWorkflow.jobs.release?.permissions).toEqual({
      'id-token': 'write',
      contents: 'write',
    });
    expect(releaseWorkflow.jobs.release?.with?.github_hosted_runner).toBe(true);
    expect(releaseWorkflow.jobs.release?.with?.runs_on).toBeUndefined();
    expect(releaseWorkflow.jobs.sibling?.permissions).toBeUndefined();
  });
});

test('workspace npm releases grant trusted-publishing permission to the caller', async () => {
  await withTempWorkflowsRepo('wbfy-workflow-workspace-npm-oidc-', async (dirPath, workflowsPath) => {
    const workspaceDirPath = path.join(dirPath, 'packages', 'public-package');
    fs.mkdirSync(workspaceDirPath, { recursive: true });
    fs.writeFileSync(
      path.join(dirPath, 'package.json'),
      JSON.stringify({ name: 'private-root', private: true, workspaces: ['packages/*'] })
    );
    fs.writeFileSync(path.join(workspaceDirPath, 'package.json'), JSON.stringify({ name: 'public-package' }));
    const rootConfig = createConfig({
      dirPath,
      isRoot: true,
      isPublicRepo: false,
      doesContainSubPackageJsons: true,
      depending: { ...createConfig().depending, semanticRelease: true },
      packageJson: { name: 'private-root', private: true, workspaces: ['packages/*'] },
      release: { branches: ['main'], github: true, npm: false, npmPublishesRoot: false },
    });
    const workspaceConfig = createConfig({
      dirPath: workspaceDirPath,
      release: {
        branches: ['main'],
        github: true,
        npm: true,
        npmPublishDirPaths: [workspaceDirPath],
        npmPublishesRoot: true,
      },
    });

    await generateWorkflows(rootConfig, [rootConfig, workspaceConfig]);
    await promisePool.promiseAll();

    expect(readWorkflow(workflowsPath, 'release.yml').jobs.release?.permissions?.['id-token']).toBe('write');
  });
});

test('private npm target is not confused with unrelated public workspace manifests', async () => {
  await withTempWorkflowsRepo('wbfy-workflow-private-target-', async (dirPath, workflowsPath) => {
    const privatePackageDirPath = path.join(dirPath, 'packages', 'cli');
    fs.mkdirSync(privatePackageDirPath, { recursive: true });
    fs.mkdirSync(path.join(dirPath, 'packages', 'app'), { recursive: true });
    fs.writeFileSync(
      path.join(dirPath, 'package.json'),
      JSON.stringify({ name: 'private-root', private: true, workspaces: ['packages/*'] })
    );
    fs.writeFileSync(
      path.join(privatePackageDirPath, 'package.json'),
      JSON.stringify({ name: '@willbooster-private/cli' })
    );
    fs.writeFileSync(path.join(dirPath, 'packages', 'app', 'package.json'), JSON.stringify({ name: 'app' }));
    const rootConfig = createConfig({
      dirPath,
      isRoot: true,
      isPublicRepo: false,
      doesContainSubPackageJsons: true,
      depending: { ...createConfig().depending, semanticRelease: true },
      packageJson: { name: 'private-root', private: true, workspaces: ['packages/*'] },
      release: {
        branches: ['main'],
        github: true,
        npm: true,
        npmPublishDirPaths: [privatePackageDirPath],
        npmPublishesRoot: false,
      },
    });
    const appConfig = createConfig({ dirPath: path.join(dirPath, 'packages', 'app') });

    await generateWorkflows(rootConfig, [rootConfig, appConfig]);
    await promisePool.promiseAll();

    const releaseWorkflow = readWorkflow(workflowsPath, 'release.yml');
    expect(releaseWorkflow.permissions).toEqual({ contents: 'write' });
    expect(releaseWorkflow.jobs.release?.with?.github_hosted_runner).toBeUndefined();
  });
});

test('explicit npm target keeps trusted publishing before its manifest is built', async () => {
  await withTempWorkflowsRepo('wbfy-workflow-unbuilt-npm-target-', async (dirPath, workflowsPath) => {
    fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify({ name: 'private-root', private: true }));
    const rootConfig = createConfig({
      dirPath,
      isRoot: true,
      isPublicRepo: false,
      depending: { ...createConfig().depending, semanticRelease: true },
      packageJson: { name: 'private-root', private: true },
      release: {
        branches: ['main'],
        github: true,
        npm: true,
        npmPublishDirPaths: [path.join(dirPath, 'dist')],
        npmPublishesRoot: false,
      },
    });

    await generateWorkflows(rootConfig);
    await promisePool.promiseAll();

    const releaseWorkflow = readWorkflow(workflowsPath, 'release.yml');
    expect(releaseWorkflow.jobs.release?.permissions?.['id-token']).toBe('write');
    expect(releaseWorkflow.jobs.release?.with?.github_hosted_runner).toBe(true);
  });
});

test('unbuilt private-scope target stays on the private registry', async () => {
  await withTempWorkflowsRepo('wbfy-workflow-unbuilt-private-target-', async (dirPath, workflowsPath) => {
    const packageJson = { name: '@willbooster-private/tool', private: true };
    fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify(packageJson));
    const rootConfig = createConfig({
      dirPath,
      isRoot: true,
      isPublicRepo: false,
      depending: { ...createConfig().depending, semanticRelease: true },
      packageJson,
      release: {
        branches: ['main'],
        github: true,
        npm: true,
        npmPublishDirPaths: [path.join(dirPath, 'dist')],
        npmPublishesRoot: false,
      },
    });

    await generateWorkflows(rootConfig);
    await promisePool.promiseAll();

    expect(readWorkflow(workflowsPath, 'release.yml').permissions).toEqual({ contents: 'write' });
  });
});

test('explicit root publishing is classified after package metadata normalization', async () => {
  await withTempWorkflowsRepo('wbfy-workflow-normalized-root-', async (dirPath, workflowsPath) => {
    const packageJson = { name: 'public-package', private: true, workspaces: ['packages/*'] };
    fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify(packageJson));
    const rootConfig = createConfig({
      dirPath,
      isRoot: true,
      isPublicRepo: false,
      doesContainSubPackageJsons: true,
      depending: { ...createConfig().depending, semanticRelease: true },
      packageJson,
      release: {
        branches: ['main'],
        github: true,
        npm: true,
        npmPublishDirPaths: [dirPath],
        npmPublishesRoot: true,
      },
    });

    await generateWorkflows(rootConfig);
    await promisePool.promiseAll();

    expect(readWorkflow(workflowsPath, 'release.yml').jobs.release?.permissions?.['id-token']).toBe('write');
  });
});

test('single-package private manifests stay unpublished despite an npm plugin', async () => {
  await withTempWorkflowsRepo('wbfy-workflow-private-single-package-', async (dirPath, workflowsPath) => {
    const packageJson = { name: 'private-package', private: true };
    fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify(packageJson));
    const rootConfig = createConfig({
      dirPath,
      isRoot: true,
      isPublicRepo: false,
      depending: { ...createConfig().depending, semanticRelease: true },
      packageJson,
      release: {
        branches: ['main'],
        github: true,
        npm: true,
        npmPublishDirPaths: [dirPath],
        npmPublishesRoot: true,
      },
    });

    await generateWorkflows(rootConfig);
    await promisePool.promiseAll();

    expect(readWorkflow(workflowsPath, 'release.yml').permissions).toEqual({ contents: 'write' });
  });
});

test('workspace defaults inherit an explicit npm-free root plugin list', async () => {
  await withTempWorkflowsRepo('wbfy-workflow-root-plugin-inheritance-', async (dirPath, workflowsPath) => {
    const workspaceDirPath = path.join(dirPath, 'packages', 'app');
    fs.mkdirSync(workspaceDirPath, { recursive: true });
    fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify({ name: 'root', private: true }));
    fs.writeFileSync(path.join(workspaceDirPath, 'package.json'), JSON.stringify({ name: 'app' }));
    const rootConfig = createConfig({
      dirPath,
      isRoot: true,
      isPublicRepo: false,
      depending: { ...createConfig().depending, semanticRelease: true },
      release: {
        branches: ['main'],
        github: true,
        npm: false,
        pluginsAreExplicit: true,
        npmPublishDirPaths: [],
        npmPublishesRoot: false,
      },
    });
    const workspaceConfig = createConfig({
      dirPath: workspaceDirPath,
      release: {
        branches: [],
        github: true,
        npm: false,
        pluginsAreExplicit: false,
        npmPublishDirPaths: [],
        npmPublishesRoot: false,
      },
    });

    await generateWorkflows(rootConfig, [rootConfig, workspaceConfig]);
    await promisePool.promiseAll();

    expect(readWorkflow(workflowsPath, 'release.yml').permissions).toEqual({ contents: 'write' });
  });
});

test('workspace defaults inherit an explicit root npm plugin', async () => {
  await withTempWorkflowsRepo('wbfy-workflow-root-npm-inheritance-', async (dirPath, workflowsPath) => {
    const workspaceDirPath = path.join(dirPath, 'packages', 'app');
    fs.mkdirSync(workspaceDirPath, { recursive: true });
    fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify({ name: 'root', private: true }));
    fs.writeFileSync(path.join(workspaceDirPath, 'package.json'), JSON.stringify({ name: 'app' }));
    const rootConfig = createConfig({
      dirPath,
      isRoot: true,
      isPublicRepo: false,
      depending: { ...createConfig().depending, semanticRelease: true },
      packageJson: { name: 'root', private: true },
      release: {
        branches: ['main'],
        github: true,
        npm: true,
        pluginsAreExplicit: true,
        npmPublishDirPaths: [dirPath],
        npmPublishesRoot: false,
      },
    });
    const workspaceConfig = createConfig({
      dirPath: workspaceDirPath,
      packageJson: { name: 'app' },
      release: {
        branches: [],
        github: true,
        npm: false,
        pluginsAreExplicit: false,
        npmPublishDirPaths: [],
        npmPublishesRoot: false,
      },
    });

    await generateWorkflows(rootConfig, [rootConfig, workspaceConfig]);
    await promisePool.promiseAll();

    expect(readWorkflow(workflowsPath, 'release.yml').jobs.release?.permissions?.['id-token']).toBe('write');
  });
});

test('public npm publishing preserves an explicit GitHub-hosted runner label', async () => {
  await withTempWorkflowsRepo('wbfy-workflow-public-runner-', async (dirPath, workflowsPath) => {
    fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify({ name: 'public-package' }));
    fs.writeFileSync(
      path.join(workflowsPath, 'release.yml'),
      `jobs:\n  release:\n    uses: WillBooster/reusable-workflows/.github/workflows/release.yml@main\n    with:\n      runs_on: '["ubuntu-latest-8-cores"]'\n`
    );
    const rootConfig = createConfig({
      dirPath,
      isRoot: true,
      isPublicRepo: false,
      depending: { ...createConfig().depending, semanticRelease: true },
      release: {
        branches: ['main'],
        github: true,
        npm: true,
        npmPublishDirPaths: [dirPath],
        npmPublishesRoot: true,
      },
    });

    await generateWorkflows(rootConfig);
    await promisePool.promiseAll();

    expect(readWorkflow(workflowsPath, 'release.yml').jobs.release?.with?.runs_on).toBe('["ubuntu-latest-8-cores"]');
  });
});

test('dynamic release configuration does not grant OIDC to a private repository', async () => {
  await withTempWorkflowsRepo('wbfy-workflow-dynamic-release-', async (dirPath, workflowsPath) => {
    fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify({ name: 'public-package' }));
    const rootConfig = createConfig({
      dirPath,
      isRoot: true,
      isPublicRepo: false,
      depending: { ...createConfig().depending, semanticRelease: true },
      packageJson: { name: 'public-package' },
      release: { branches: ['main'], github: true, npm: true, npmPublishesRoot: false },
    });

    await generateWorkflows(rootConfig);
    await promisePool.promiseAll();

    expect(readWorkflow(workflowsPath, 'release.yml').permissions).toEqual({ contents: 'write' });
  });
});

test('dynamic release configuration preserves existing trusted-publishing settings', async () => {
  await withTempWorkflowsRepo('wbfy-workflow-dynamic-preserved-', async (dirPath, workflowsPath) => {
    fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify({ name: 'public-package' }));
    fs.writeFileSync(
      path.join(workflowsPath, 'release.yml'),
      `permissions:\n  id-token: write\n  contents: write\njobs:\n  release:\n    uses: WillBooster/reusable-workflows/.github/workflows/release.yml@main\n    with:\n      github_hosted_runner: true\n`
    );
    const rootConfig = createConfig({
      dirPath,
      isRoot: true,
      isPublicRepo: false,
      depending: { ...createConfig().depending, semanticRelease: true },
      packageJson: { name: 'public-package' },
      release: { branches: ['main'], github: true, npm: true, npmPublishesRoot: false },
    });

    await generateWorkflows(rootConfig);
    await promisePool.promiseAll();

    const releaseWorkflow = readWorkflow(workflowsPath, 'release.yml');
    expect(releaseWorkflow.permissions?.['id-token']).toBeUndefined();
    expect(releaseWorkflow.jobs.release?.permissions?.['id-token']).toBe('write');
    expect(releaseWorkflow.jobs.release?.with?.github_hosted_runner).toBe(true);
  });
});

test('dynamic release configuration does not infer a pkgRoot registry from source metadata', async () => {
  await withTempWorkflowsRepo('wbfy-workflow-dynamic-public-registry-', async (dirPath, workflowsPath) => {
    const packageJson = {
      name: 'public-package',
      publishConfig: { registry: 'https://registry.npmjs.org/' },
    };
    fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify(packageJson));
    const rootConfig = createConfig({
      dirPath,
      isRoot: true,
      isPublicRepo: false,
      depending: { ...createConfig().depending, semanticRelease: true },
      packageJson,
      release: { branches: ['main'], github: true, npm: true, npmPublishesRoot: false },
    });

    await generateWorkflows(rootConfig);
    await promisePool.promiseAll();

    const releaseWorkflow = readWorkflow(workflowsPath, 'release.yml');
    expect(releaseWorkflow.jobs.release?.permissions?.['id-token']).toBeUndefined();
    expect(releaseWorkflow.jobs.release?.with?.github_hosted_runner).toBeUndefined();
  });
});

test('public dynamic release configuration honors an explicit custom registry', async () => {
  await withTempWorkflowsRepo('wbfy-workflow-dynamic-custom-registry-', async (dirPath, workflowsPath) => {
    const packageJson = {
      name: 'custom-package',
      publishConfig: { registry: 'https://npm.example.com/' },
    };
    fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify(packageJson));
    const rootConfig = createConfig({
      dirPath,
      isRoot: true,
      isPublicRepo: true,
      depending: { ...createConfig().depending, semanticRelease: true },
      packageJson,
      release: { branches: ['main'], github: true, npm: true, npmPublishesRoot: false },
    });

    await generateWorkflows(rootConfig);
    await promisePool.promiseAll();

    expect(readWorkflow(workflowsPath, 'release.yml').permissions).toEqual({ contents: 'write' });
  });
});

test('custom registry target does not receive npm trusted-publishing settings', async () => {
  await withTempWorkflowsRepo('wbfy-workflow-custom-registry-', async (dirPath, workflowsPath) => {
    fs.writeFileSync(
      path.join(dirPath, 'package.json'),
      JSON.stringify({ name: 'custom-package', publishConfig: { registry: 'https://npm.example.com/' } })
    );
    const rootConfig = createConfig({
      dirPath,
      isRoot: true,
      isPublicRepo: false,
      depending: { ...createConfig().depending, semanticRelease: true },
      packageJson: { name: 'custom-package', publishConfig: { registry: 'https://npm.example.com/' } },
      release: {
        branches: ['main'],
        github: true,
        npm: true,
        npmPublishDirPaths: [dirPath],
        npmPublishesRoot: true,
      },
    });

    await generateWorkflows(rootConfig);
    await promisePool.promiseAll();

    const releaseWorkflow = readWorkflow(workflowsPath, 'release.yml');
    expect(releaseWorkflow.permissions).toEqual({ contents: 'write' });
    expect(releaseWorkflow.jobs.release?.with?.github_hosted_runner).toBeUndefined();
  });
});

function readPermissions(workflowsPath: string, fileName: string): Record<string, string> | undefined {
  const workflow = readWorkflow(workflowsPath, fileName);
  expect(workflow.permissions).toBeUndefined();
  expect(siblingJobSchema.parse(workflow.jobs.sibling)).toEqual({
    'runs-on': 'ubuntu-latest',
    steps: [{ run: 'echo preserved' }],
  });
  const callerName = fileName.slice(0, -'.yml'.length);
  return workflow.jobs[callerName]?.permissions;
}

function readWorkflow(workflowsPath: string, fileName: string): z.infer<typeof workflowSchema> {
  return workflowSchema.parse(YAML.parse(fs.readFileSync(path.join(workflowsPath, fileName), 'utf8')));
}
