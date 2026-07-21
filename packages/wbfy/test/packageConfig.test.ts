import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { getPackageConfig } from '../src/packageConfig.js';

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

test('detects a nested Tauri application from a parent package', async () => {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-package-config-'));
  try {
    const srcTauriDirPath = path.join(tempDirPath, 'packages', 'root', 'packages', 'app', 'src-tauri');
    fs.mkdirSync(srcTauriDirPath, { recursive: true });
    // The packages/root layout keeps getPackageConfig from looking up a GitHub repository.
    fs.writeFileSync(path.join(tempDirPath, 'package.json'), '{}');
    fs.writeFileSync(path.join(tempDirPath, 'packages', 'root', 'package.json'), '{}');
    fs.writeFileSync(path.join(srcTauriDirPath, 'tauri.conf.json'), '{}');
    const config = await getPackageConfig(path.join(tempDirPath, 'packages', 'root'));
    expect(config?.doesContainTauriConfig).toBe(false);
    expect(config?.doesContainTauriConfigInPackages).toBe(true);
  } finally {
    fs.rmSync(tempDirPath, { recursive: true, force: true });
  }
});

test('detects prettier imported as a runtime library, ignoring prefix-sharing packages', async () => {
  const tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wbfy-package-config-'));
  try {
    // The packages/root layout keeps getPackageConfig from looking up a GitHub repository.
    const packageDirPath = path.join(tempDirPath, 'packages', 'root');
    const srcDirPath = path.join(packageDirPath, 'src');
    fs.mkdirSync(srcDirPath, { recursive: true });
    fs.writeFileSync(path.join(tempDirPath, 'package.json'), '{}');
    fs.writeFileSync(path.join(packageDirPath, 'package.json'), '{}');
    const sourcePath = path.join(srcDirPath, 'format.ts');

    // A package that only shares the `prettier` prefix must not count as importing prettier.
    fs.writeFileSync(sourcePath, "import organizeAttributes from 'prettier-plugin-organize-attributes';\n");
    const prefixOnlyConfig = await getPackageConfig(packageDirPath);
    expect(prefixOnlyConfig?.depending.prettierRuntime).toBe(false);

    fs.writeFileSync(sourcePath, "import { format } from 'prettier';\n");
    const bareImportConfig = await getPackageConfig(packageDirPath);
    expect(bareImportConfig?.depending.prettierRuntime).toBe(true);

    // Subpath specifiers (e.g. the browser build) count too.
    fs.writeFileSync(sourcePath, "import { format } from 'prettier/standalone';\n");
    const subpathImportConfig = await getPackageConfig(packageDirPath);
    expect(subpathImportConfig?.depending.prettierRuntime).toBe(true);
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
