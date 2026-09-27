import fs from 'node:fs';
import path from 'node:path';

import { YAML } from 'bun';
import { expect, test } from 'bun:test';
import { z } from 'zod';

import { generateWorkflows } from '../../src/generators/workflow.js';
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
    for (const workflowName of ['test-rust', 'semantic-pr']) {
      fs.writeFileSync(
        path.join(workflowsPath, `${workflowName}.yml`),
        `jobs:\n  ${workflowName}:\n    permissions:\n      contents: write\n    uses: WillBooster/reusable-workflows/.github/workflows/${workflowName}.yml@main\n  sibling:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo preserved\n`
      );
    }
    fs.writeFileSync(
      path.join(workflowsPath, 'custom.yml'),
      `jobs:\n  rust:\n    permissions:\n      contents: write\n    uses: WillBooster/reusable-workflows/.github/workflows/test-rust.yml@main\n  pr:\n    permissions:\n      contents: write\n    uses: WillBooster/reusable-workflows/.github/workflows/semantic-pr.yml@main\n`
    );

    await generateWorkflows(createConfig({ dirPath, isRoot: true, cargoTomlDirPaths: ['native'] }));

    expect(readPermissions(workflowsPath, 'test-rust.yml')).toEqual({
      actions: 'read',
      contents: 'read',
    });
    expect(readPermissions(workflowsPath, 'semantic-pr.yml')).toEqual({
      'pull-requests': 'read',
      statuses: 'write',
    });
    const customWorkflow = readWorkflow(workflowsPath, 'custom.yml');
    expect(customWorkflow.jobs.rust?.permissions).toEqual({ actions: 'read', contents: 'read' });
    expect(customWorkflow.jobs.pr?.permissions).toEqual({ 'pull-requests': 'read', statuses: 'write' });
  });
});

test('preserves an inline test job when its name matches the reusable template', async () => {
  await withTempWorkflowsRepo('wbfy-inline-test-', async (dirPath, workflowsPath) => {
    fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify({ name: 'example' }));
    const filePath = path.join(workflowsPath, 'test.yml');
    fs.writeFileSync(filePath, `jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo preserved\n`);
    const config = createConfig({ dirPath, isRoot: true, isPublicRepo: true });

    await generateWorkflows(config);
    expect(readWorkflow(workflowsPath, 'test.yml').permissions).toBeUndefined();
    expect(siblingJobSchema.parse(readWorkflow(workflowsPath, 'test.yml').jobs.test)).toEqual({
      'runs-on': 'ubuntu-latest',
      steps: [{ run: 'echo preserved' }],
    });

    await generateWorkflows(config);
    expect(readWorkflow(workflowsPath, 'test.yml').permissions).toBeUndefined();
    expect(siblingJobSchema.parse(readWorkflow(workflowsPath, 'test.yml').jobs.test)).toEqual({
      'runs-on': 'ubuntu-latest',
      steps: [{ run: 'echo preserved' }],
    });

    fs.writeFileSync(
      filePath,
      `permissions:\n  actions: write\n  contents: write\n  pull-requests: read\njobs:\n  test:\n    uses: WillBooster/reusable-workflows/.github/workflows/test.yml@main\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo preserved\n    with:\n      github_hosted_runner: true\n    secrets:\n      GH_TOKEN: inherited\n`
    );
    await generateWorkflows(config);
    expect(readWorkflow(workflowsPath, 'test.yml').permissions).toBeUndefined();
    expect(siblingJobSchema.parse(readWorkflow(workflowsPath, 'test.yml').jobs.test)).toEqual({
      'runs-on': 'ubuntu-latest',
      steps: [{ run: 'echo preserved' }],
    });
  });
});

test('keeps an inline Rust test when Rust code is removed', async () => {
  await withTempWorkflowsRepo('wbfy-inline-rust-', async (dirPath, workflowsPath) => {
    fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify({ name: 'example' }));
    fs.writeFileSync(
      path.join(workflowsPath, 'test-rust.yml'),
      `jobs:\n  test-rust:\n    uses: WillBooster/reusable-workflows/.github/workflows/test-rust.yml@main\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo preserved\n    permissions:\n      actions: read\n      contents: read\n`
    );

    await generateWorkflows(createConfig({ dirPath, isRoot: true, cargoTomlDirPaths: [] }));

    expect(siblingJobSchema.parse(readWorkflow(workflowsPath, 'test-rust.yml').jobs['test-rust'])).toEqual({
      'runs-on': 'ubuntu-latest',
      steps: [{ run: 'echo preserved' }],
    });
  });
});

test('leaves a custom same-named workflow alone without Rust code', async () => {
  await withTempWorkflowsRepo('wbfy-custom-test-rust-', async (dirPath, workflowsPath) => {
    fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify({ name: 'example' }));
    const filePath = path.join(workflowsPath, 'test-rust.yml');
    const content = `jobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo preserved\n`;
    fs.writeFileSync(filePath, content);

    await generateWorkflows(createConfig({ dirPath, isRoot: true, cargoTomlDirPaths: [] }));

    expect(fs.readFileSync(filePath, 'utf8')).toBe(content);
  });
});

test('removes a generated force-sync caller when sync becomes an inline job', async () => {
  await withTempWorkflowsRepo('wbfy-inline-sync-', async (dirPath, workflowsPath) => {
    fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify({ name: 'example' }));
    fs.writeFileSync(
      path.join(workflowsPath, 'sync.yml'),
      `jobs:\n  sync:\n    uses: WillBooster/reusable-workflows/.github/workflows/sync.yml@main\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo preserved\n    with:\n      sync_params_without_dest: --source source\n`
    );
    fs.writeFileSync(
      path.join(workflowsPath, 'sync-force.yml'),
      `jobs:\n  sync-force:\n    uses: WillBooster/reusable-workflows/.github/workflows/sync.yml@main\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo preserved\n    with:\n      sync_params_without_dest: --force --source source\n`
    );

    await generateWorkflows(createConfig({ dirPath, isRoot: true, isPublicRepo: true }));

    expect(siblingJobSchema.parse(readWorkflow(workflowsPath, 'sync.yml').jobs.sync)).toEqual({
      'runs-on': 'ubuntu-latest',
      steps: [{ run: 'echo preserved' }],
    });
    expect(fs.existsSync(path.join(workflowsPath, 'sync-force.yml'))).toBe(false);
  });
});

test('removes an invalid generated force-sync caller with copied sibling jobs', async () => {
  await withTempWorkflowsRepo('wbfy-force-sync-siblings-', async (dirPath, workflowsPath) => {
    fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify({ name: 'example' }));
    fs.writeFileSync(
      path.join(workflowsPath, 'sync.yml'),
      `jobs:\n  sync:\n    uses: WillBooster/reusable-workflows/.github/workflows/sync.yml@main\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo preserved\n    with:\n      sync_params_without_dest: --source source\n  extra:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo preserved\n`
    );
    fs.writeFileSync(
      path.join(workflowsPath, 'sync-force.yml'),
      `jobs:\n  sync-force:\n    uses: WillBooster/reusable-workflows/.github/workflows/sync.yml@main\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo preserved\n    with:\n      sync_params_without_dest: --force --source source\n  extra:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo preserved\n`
    );

    await generateWorkflows(createConfig({ dirPath, isRoot: true }));

    expect(fs.existsSync(path.join(workflowsPath, 'sync-force.yml'))).toBe(false);
    expect(siblingJobSchema.parse(readWorkflow(workflowsPath, 'sync.yml').jobs.extra)).toEqual({
      'runs-on': 'ubuntu-latest',
      steps: [{ run: 'echo preserved' }],
    });
  });
});

test('keeps a valid force-sync caller beside an inline sync job', async () => {
  await withTempWorkflowsRepo('wbfy-valid-force-sync-', async (dirPath, workflowsPath) => {
    fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify({ name: 'example' }));
    fs.writeFileSync(
      path.join(workflowsPath, 'sync.yml'),
      `jobs:\n  sync:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo preserved\n`
    );
    const filePath = path.join(workflowsPath, 'sync-force.yml');
    const content = `jobs:\n  sync-force:\n    uses: WillBooster/reusable-workflows/.github/workflows/sync.yml@main\n    with:\n      sync_params_without_dest: --force special-source\n`;
    fs.writeFileSync(filePath, content);

    await generateWorkflows(createConfig({ dirPath, isRoot: true }));

    expect(fs.existsSync(filePath)).toBe(true);
    expect(readWorkflow(workflowsPath, 'sync-force.yml').jobs['sync-force']?.uses).toBe(
      'WillBooster/reusable-workflows/.github/workflows/sync.yml@main'
    );
  });
});

test('keeps write access for inline release and sync jobs', async () => {
  await withTempWorkflowsRepo('wbfy-inline-write-jobs-', async (dirPath, workflowsPath) => {
    fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify({ name: 'example' }));
    for (const kind of ['release', 'sync']) {
      fs.writeFileSync(
        path.join(workflowsPath, `${kind}.yml`),
        `jobs:\n  ${kind}:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${kind}\n`
      );
    }
    const base = createConfig();
    await generateWorkflows(createConfig({ dirPath, isRoot: true, release: { ...base.release, branches: ['main'] } }));

    expect(readWorkflow(workflowsPath, 'release.yml').permissions?.contents).toBe('write');
    expect(readWorkflow(workflowsPath, 'sync.yml').permissions?.contents).toBe('write');
  });
});

test('does not grant caller-only test permissions to an inline test beside a reusable sibling', async () => {
  await withTempWorkflowsRepo('wbfy-mixed-test-jobs-', async (dirPath, workflowsPath) => {
    fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify({ name: 'example' }));
    fs.writeFileSync(
      path.join(workflowsPath, 'test.yml'),
      `jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo preserved\n  lint-pr:\n    uses: WillBooster/reusable-workflows/.github/workflows/semantic-pr.yml@main\n`
    );

    await generateWorkflows(createConfig({ dirPath, isRoot: true }));

    const workflow = readWorkflow(workflowsPath, 'test.yml');
    expect(workflow.permissions).toBeUndefined();
    expect(siblingJobSchema.parse(workflow.jobs.test)).toEqual({
      'runs-on': 'ubuntu-latest',
      steps: [{ run: 'echo preserved' }],
    });
    expect(workflow.jobs['lint-pr']?.permissions).toEqual({ 'pull-requests': 'read', statuses: 'write' });
  });
});

test('preserves permissions explicitly set on an inline test workflow', async () => {
  await withTempWorkflowsRepo('wbfy-explicit-test-permissions-', async (dirPath, workflowsPath) => {
    fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify({ name: 'example' }));
    fs.writeFileSync(
      path.join(workflowsPath, 'test.yml'),
      `permissions:\n  actions: write\n  contents: write\n  pull-requests: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: git push --dry-run\n`
    );

    await generateWorkflows(createConfig({ dirPath, isRoot: true }));

    expect(readWorkflow(workflowsPath, 'test.yml').permissions).toEqual({
      actions: 'write',
      contents: 'write',
      'pull-requests': 'read',
    });
  });
});

test('leaves a third-party hybrid job in an unmanaged workflow untouched', async () => {
  await withTempWorkflowsRepo('wbfy-third-party-workflow-', async (dirPath, workflowsPath) => {
    fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify({ name: 'example' }));
    const filePath = path.join(workflowsPath, 'custom.yml');
    const content = `# Keep this custom workflow\njobs:\n  external:\n    uses: OtherOrg/actions/.github/workflows/test.yml@main\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo preserved\n`;
    fs.writeFileSync(filePath, content);

    await generateWorkflows(createConfig({ dirPath, isRoot: true }));

    expect(fs.readFileSync(filePath, 'utf8')).toBe(content);
  });
});

test('does not replace a third-party hybrid caller in a managed workflow', async () => {
  await withTempWorkflowsRepo('wbfy-third-party-test-', async (dirPath, workflowsPath) => {
    fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify({ name: 'example' }));
    const filePath = path.join(workflowsPath, 'test.yml');
    const content = `jobs:\n  test:\n    uses: OtherOrg/actions/.github/workflows/test.yml@main\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo preserved\n`;
    fs.writeFileSync(filePath, content);

    await generateWorkflows(createConfig({ dirPath, isRoot: true }));

    expect(fs.readFileSync(filePath, 'utf8')).toBe(content);
  });
});

test('generated close-comment callers are removed', async () => {
  await withTempWorkflowsRepo('wbfy-workflow-close-comment-', async (dirPath, workflowsPath) => {
    fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify({ name: 'example' }));
    fs.writeFileSync(
      path.join(workflowsPath, 'close-comment.yml'),
      `jobs:\n  close-comment:\n    uses: WillBooster/reusable-workflows/.github/workflows/close-comment.yml@main\n`
    );

    await generateWorkflows(createConfig({ dirPath, isRoot: true }));

    expect(fs.existsSync(path.join(workflowsPath, 'close-comment.yml'))).toBe(false);
  });
});

test('customized close-comment workflows are preserved', async () => {
  await withTempWorkflowsRepo('wbfy-workflow-custom-close-comment-', async (dirPath, workflowsPath) => {
    fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify({ name: 'example' }));
    fs.writeFileSync(
      path.join(workflowsPath, 'close-comment.yml'),
      `jobs:\n  close-comment:\n    uses: WillBooster/reusable-workflows/.github/workflows/close-comment.yml@main\n  sibling:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo preserved\n`
    );

    await generateWorkflows(createConfig({ dirPath, isRoot: true }));

    expect(siblingJobSchema.parse(readWorkflow(workflowsPath, 'close-comment.yml').jobs.sibling)).toEqual({
      'runs-on': 'ubuntu-latest',
      steps: [{ run: 'echo preserved' }],
    });
  });
});

test('repairs a legacy inline close-comment caller without removing sibling jobs', async () => {
  await withTempWorkflowsRepo('wbfy-inline-close-comment-', async (dirPath, workflowsPath) => {
    fs.writeFileSync(path.join(dirPath, 'package.json'), JSON.stringify({ name: 'example' }));
    fs.writeFileSync(
      path.join(workflowsPath, 'close-comment.yml'),
      `jobs:\n  close-comment:\n    uses: WillBooster/reusable-workflows/.github/workflows/close-comment.yml@main\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo preserved\n  sibling:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo preserved\n`
    );

    await generateWorkflows(createConfig({ dirPath, isRoot: true }));

    const workflow = readWorkflow(workflowsPath, 'close-comment.yml');
    expect(siblingJobSchema.parse(workflow.jobs['close-comment'])).toEqual({
      'runs-on': 'ubuntu-latest',
      steps: [{ run: 'echo preserved' }],
    });
    expect(siblingJobSchema.parse(workflow.jobs.sibling)).toEqual({
      'runs-on': 'ubuntu-latest',
      steps: [{ run: 'echo preserved' }],
    });
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
