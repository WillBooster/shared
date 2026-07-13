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
