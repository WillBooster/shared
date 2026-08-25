import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'bun:test';

import { generateWorkflows } from '../../src/generators/workflow.js';
import { getPackageConfig } from '../../src/packageConfig.js';
import { promisePool } from '../../src/utils/promisePool.js';

// Regression test for the direct workspace-child invocation (`wbfy <repo>/packages/<app>`):
// the entry keeps its child classification, but repository visibility must still be fetched
// because generators read isPublicRepo from this config as their rootConfig.
test('fetches repository visibility when the CLI entry is a workspace child', async () => {
  const config = await getPackageConfig(path.resolve(import.meta.dirname, '..', '..', '..', 'shared-lib'));
  expect(config?.isRoot).toBe(false);
  expect(config?.isPublicRepo).toBe(true);
});

test('detects Tauri packages from every supported signal', async () => {
  expect(await detectTauri({ packageJson: { dependencies: { '@tauri-apps/api': '2.0.0' } } })).toBe(true);
  expect(await detectTauri({ packageJson: { devDependencies: { '@tauri-apps/api': '2.0.0' } } })).toBe(true);
  expect(await detectTauri({ packageJson: { dependencies: { '@tauri-apps/cli': '2.0.0' } } })).toBe(true);
  expect(await detectTauri({ packageJson: { devDependencies: { '@tauri-apps/cli': '2.0.0' } } })).toBe(true);
  expect(await detectTauri({ srcTauriFileName: 'tauri.conf.json' })).toBe(true);
  expect(await detectTauri({ srcTauriFileName: 'tauri.conf.json5' })).toBe(true);
  expect(await detectTauri({ srcTauriFileName: 'Tauri.toml' })).toBe(true);
  expect(await detectTauri({})).toBe(false);
});

test('accepts Cargo-only Tauri projects without a package.json', async () => {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-package-config-'));
  try {
    const srcTauriDirPath = path.join(tempDirPath, 'packages', 'app', 'src-tauri');
    fs.mkdirSync(srcTauriDirPath, { recursive: true });
    fs.writeFileSync(path.join(tempDirPath, 'package.json'), '{}');
    fs.writeFileSync(path.join(srcTauriDirPath, 'tauri.conf.json'), '{}');
    const config = await getPackageConfig(path.join(tempDirPath, 'packages', 'app'));
    expect(config).toBeDefined();
    expect(config?.doesContainTauriConfig).toBe(true);
    expect(config?.depending.tauri).toBe(true);
  } finally {
    fs.rmSync(tempDirPath, { recursive: true, force: true });
  }
});

test('accepts a documentation-only Git repository without a package.json', async () => {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-package-config-'));
  try {
    fs.mkdirSync(path.join(tempDirPath, '.git'));
    fs.writeFileSync(path.join(tempDirPath, 'README.md'), '# Documentation\n');

    const config = await getPackageConfig(tempDirPath);

    expect(config).toBeDefined();
    expect(config?.isRoot).toBe(true);
    expect(config?.doesContainPackageJson).toBe(false);
  } finally {
    fs.rmSync(tempDirPath, { recursive: true, force: true });
  }
});

test('removes a generated Rust workflow based only on a cached Cargo project', async () => {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-package-config-'));
  try {
    fs.writeFileSync(path.join(tempDirPath, 'package.json'), '{}');
    const packageDirPath = path.join(tempDirPath, 'packages', 'root');
    const workflowsDirPath = path.join(packageDirPath, '.github', 'workflows');
    fs.mkdirSync(path.join(packageDirPath, '.cache', 'clap-rs__clap'), { recursive: true });
    fs.mkdirSync(workflowsDirPath, { recursive: true });
    fs.writeFileSync(path.join(packageDirPath, 'package.json'), '{}');
    fs.writeFileSync(path.join(packageDirPath, '.cache', 'clap-rs__clap', 'Cargo.toml'), '');
    fs.writeFileSync(
      path.join(workflowsDirPath, 'test-rust.yml'),
      `name: Test Rust
on: push
jobs:
  test-rust:
    uses: WillBooster/reusable-workflows/.github/workflows/test-rust.yml@main
`
    );

    const config = await getPackageConfig(packageDirPath);
    if (!config) throw new Error('unreachable');
    expect(config?.cargoTomlDirPaths).toEqual([]);
    await generateWorkflows(config);
    await promisePool.promiseAll();
    expect(fs.existsSync(path.join(workflowsDirPath, 'test-rust.yml'))).toBe(false);
  } finally {
    fs.rmSync(tempDirPath, { recursive: true, force: true });
  }
});

test('preserves a Rust workflow whose duplicate jobs key hides a custom job', async () => {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-package-config-'));
  try {
    const packageDirPath = path.join(tempDirPath, 'packages', 'root');
    const workflowsDirPath = path.join(packageDirPath, '.github', 'workflows');
    fs.mkdirSync(workflowsDirPath, { recursive: true });
    fs.writeFileSync(path.join(tempDirPath, 'package.json'), '{}');
    fs.writeFileSync(path.join(packageDirPath, 'package.json'), '{}');
    const workflowPath = path.join(workflowsDirPath, 'test-rust.yml');
    const workflowContent = `name: Test Rust
on: push
jobs:
  custom:
    runs-on: ubuntu-latest
    steps: []
jobs:
  test-rust:
    uses: WillBooster/reusable-workflows/.github/workflows/test-rust.yml@main
`;
    fs.writeFileSync(workflowPath, workflowContent);

    const config = await getPackageConfig(packageDirPath);
    if (!config) throw new Error('unreachable');
    await generateWorkflows(config);
    await promisePool.promiseAll();

    expect(fs.readFileSync(workflowPath, 'utf8')).toBe(workflowContent);
  } finally {
    fs.rmSync(tempDirPath, { recursive: true, force: true });
  }
});

test('detects @semantic-release/npm in both string and tuple plugin forms', async () => {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-package-config-'));
  try {
    // The packages/root layout keeps getPackageConfig from looking up a GitHub repository.
    const packageDirPath = path.join(tempDirPath, 'packages', 'root');
    fs.mkdirSync(packageDirPath, { recursive: true });
    fs.writeFileSync(path.join(tempDirPath, 'package.json'), '{}');
    fs.writeFileSync(path.join(packageDirPath, 'package.json'), '{}');
    fs.writeFileSync(
      path.join(packageDirPath, '.releaserc.json'),
      JSON.stringify({
        branches: ['main'],
        plugins: ['@semantic-release/commit-analyzer', ['@semantic-release/npm', { pkgRoot: '.' }]],
      })
    );
    const config = await getPackageConfig(packageDirPath);
    expect(config?.release.npm).toBe(true);
    expect(config?.depending.semanticRelease).toBe(true);
  } finally {
    fs.rmSync(tempDirPath, { recursive: true, force: true });
  }
});

async function detectTauri(setup: { packageJson?: object; srcTauriFileName?: string }): Promise<boolean> {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-package-config-'));
  try {
    // Place the package under packages/ so getPackageConfig treats it as a sub package
    // and skips the GitHub repository lookup.
    fs.writeFileSync(path.join(tempDirPath, 'package.json'), '{}');
    const packageDirPath = path.join(tempDirPath, 'packages', 'app');
    fs.mkdirSync(packageDirPath, { recursive: true });
    fs.writeFileSync(path.join(packageDirPath, 'package.json'), JSON.stringify(setup.packageJson ?? {}));
    if (setup.srcTauriFileName) {
      const srcTauriDirPath = path.join(packageDirPath, 'src-tauri');
      fs.mkdirSync(srcTauriDirPath);
      fs.writeFileSync(path.join(srcTauriDirPath, setup.srcTauriFileName), '');
    }
    const config = await getPackageConfig(packageDirPath);
    return config?.depending.tauri ?? false;
  } finally {
    fs.rmSync(tempDirPath, { recursive: true, force: true });
  }
}
