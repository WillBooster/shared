import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { generateWorkflows } from '../../src/generators/workflow.js';
import { withTempWorkflowsRepo } from '../helpers/callerWorkflow.js';
import { createConfig } from '../helpers/testConfig.js';

test('keeps the comments and bare events of a regenerated caller workflow', async () => {
  await withTempWorkflowsRepo('wbfy-workflow-comments-', async (dirPath, workflowsPath) => {
    const filePath = path.join(workflowsPath, 'release.yml');
    fs.writeFileSync(
      filePath,
      `# Releases every push to main.
name: Release
'on':
  push:
    branches:
      - main
  # Runs are dispatched here to complete a pending release.
  workflow_dispatch:
concurrency:
  group: \${{ github.workflow }}
  cancel-in-progress: false
  queue: max
permissions:
  id-token: write
  contents: write
  # for the release to dispatch runs
  actions: write
jobs:
  release:
    uses: WillBooster/reusable-workflows/.github/workflows/release.yml@main # the shared release
    secrets: # passed to the release job
      # removed by wbfy because no private package is resolved
      VERDACCIO_TOKEN: \${{ secrets.VERDACCIO_TOKEN }}
      GH_TOKEN: \${{ secrets.GITHUB_TOKEN }} # for semantic-release
`
    );
    const config = createConfig({ dirPath, isRoot: true });
    config.depending.semanticRelease = true;
    config.release.branches = ['main'];

    await generateWorkflows(config);
    const content = fs.readFileSync(filePath, 'utf8');
    await generateWorkflows(config);

    expect(fs.readFileSync(filePath, 'utf8')).toBe(content);
    expect(content).toContain('# Releases every push to main.');
    expect(content).toContain('  # Runs are dispatched here to complete a pending release.\n  workflow_dispatch:');
    expect(content).toContain('  # for the release to dispatch runs\n  actions: write');
    expect(content).toContain('@main # the shared release');
    expect(content).toContain('    secrets: # passed to the release job');
    expect(content).toContain('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }} # for semantic-release');
    expect(content).not.toContain('# removed by wbfy because no private package is resolved');
  });
});

test('leaves the comments of an unchanged inline job in a caller workflow as written', async () => {
  await withTempWorkflowsRepo('wbfy-workflow-inline-job-comments-', async (dirPath, workflowsPath) => {
    const filePath = path.join(workflowsPath, 'custom.yml');
    const workflow = `name: Custom
'on':
  pull_request: null
jobs:
  semantic-pr:
    uses: WillBooster/reusable-workflows/.github/workflows/semantic-pr.yml@main
    permissions:
      pull-requests: read
  lint:
    runs-on: ubuntu-latest
    steps:
      # check out first
      - uses: actions/checkout@v4
      # install deps
      - run: bun i
`;
    fs.writeFileSync(filePath, workflow);

    await generateWorkflows(createConfig({ dirPath, isRoot: true }));

    expect(fs.readFileSync(filePath, 'utf8')).toBe(workflow);
  });
});

test('removes the comments of a removed sequence entry with it', async () => {
  await withTempWorkflowsRepo('wbfy-workflow-sequence-comments-', async (dirPath, workflowsPath) => {
    const filePath = path.join(workflowsPath, 'release.yml');
    const config = createConfig({ dirPath, isRoot: true });
    config.depending.semanticRelease = true;
    config.release.branches = ['main'];
    await generateWorkflows(config);
    const generated = fs.readFileSync(filePath, 'utf8');
    const branches = '    branches:\n      - main\n';
    expect(generated).toContain(branches);

    // The release caller's push branches are replaced with the semantic-release branches.
    fs.writeFileSync(
      filePath,
      generated.replace(
        branches,
        '    branches:\n      # prerelease\n      - beta # bot\n      # the main one\n      - main # keep\n'
      )
    );
    await generateWorkflows(config);

    expect(fs.readFileSync(filePath, 'utf8')).toBe(
      generated.replace(branches, '    branches:\n      # the main one\n      - main # keep\n')
    );
  });
});

test('keeps the comments of an existing force-sync workflow', async () => {
  await withTempWorkflowsRepo('wbfy-workflow-sync-comments-', async (dirPath, workflowsPath) => {
    const syncJob = `  sync:
    uses: WillBooster/reusable-workflows/.github/workflows/sync.yml@main
    with:
      sync_params_without_dest: -v https://github.com/WillBooster/upstream
`;
    fs.writeFileSync(
      path.join(workflowsPath, 'sync.yml'),
      `name: Sync\n'on':\n  schedule:\n    # every day\n    - cron: 0 0 * * *\npermissions:\n  contents: write\njobs:\n${syncJob}`
    );
    const syncForcePath = path.join(workflowsPath, 'sync-force.yml');
    fs.writeFileSync(
      syncForcePath,
      `# Overwrites the destination.\nname: Force to Sync\n'on':\n  workflow_dispatch:\npermissions:\n  contents: write\njobs:\n  sync-force:\n    uses: WillBooster/reusable-workflows/.github/workflows/sync.yml@main\n    with:\n      sync_params_without_dest: --force -v https://github.com/WillBooster/old\n`
    );

    await generateWorkflows(createConfig({ dirPath, isRoot: true }));

    expect(fs.readFileSync(path.join(workflowsPath, 'sync.yml'), 'utf8')).toContain('    # every day\n');
    expect(fs.readFileSync(syncForcePath, 'utf8')).toBe(
      `# Overwrites the destination.\nname: Force to Sync\n'on':\n  workflow_dispatch:\npermissions:\n  contents: write\njobs:\n  sync-force:\n    uses: WillBooster/reusable-workflows/.github/workflows/sync.yml@main\n    with:\n      sync_params_without_dest: --force -v https://github.com/WillBooster/upstream\n`
    );
  });
});
