import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { stripDevDependenciesFromPackageTree } from '../src/commands/setupPrivatePackages.js';

test('strips dev dependencies from every materialized private package manifest', async () => {
  const rootDirPath = await fs.promises.realpath(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-private-packages-')));
  const privatePackageDirPath = path.join(rootDirPath, '@willbooster-private', 'example');
  const nestedPackageDirPath = path.join(privatePackageDirPath, 'packages', 'nested');
  try {
    await fs.promises.mkdir(nestedPackageDirPath, { recursive: true });
    for (const packageJsonPath of [
      path.join(privatePackageDirPath, 'package.json'),
      path.join(nestedPackageDirPath, 'package.json'),
    ]) {
      await fs.promises.writeFile(
        packageJsonPath,
        JSON.stringify({
          dependencies: { runtime: '1.0.0' },
          devDependencies: { '@railway/cli': '5.26.0' },
          scripts: { postinstall: 'prepare-runtime-package' },
        })
      );
    }

    await stripDevDependenciesFromPackageTree(rootDirPath, privatePackageDirPath);

    for (const packageJsonPath of [
      path.join(privatePackageDirPath, 'package.json'),
      path.join(nestedPackageDirPath, 'package.json'),
    ]) {
      const packageJson = JSON.parse(await fs.promises.readFile(packageJsonPath, 'utf8')) as Record<string, unknown>;
      expect(packageJson.devDependencies).toBeUndefined();
      expect(packageJson.dependencies).toEqual({ runtime: '1.0.0' });
      expect(packageJson.scripts).toEqual({ postinstall: 'prepare-runtime-package' });
    }
  } finally {
    fs.rmSync(rootDirPath, { force: true, recursive: true });
  }
});
