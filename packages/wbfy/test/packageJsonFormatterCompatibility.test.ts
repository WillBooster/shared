import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sortPackageJson } from 'sort-package-json';
import type { PackageJson } from 'type-fest';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { createConfig } from './testConfig.js';

const spawnSyncMock = vi.fn<(command: string, args: string[], cwd: string) => void>();

vi.mock('../src/utils/spawnUtil.js', async () => {
  return {
    spawnSync: spawnSyncMock,
    spawnSyncAndReturnStdout: vi.fn(() => '1.0.0'),
  };
});

describe('generatePackageJson formatter compatibility', () => {
  afterEach(() => {
    spawnSyncMock.mockReset();
  });

  test('uses the target repository formatter after dependency installation', async () => {
    const { generatePackageJson } = await import('../src/generators/packageJson.js');

    const dirPath = await createPackageDir({
      name: 'formatter-compat-package',
      private: true,
      scripts: {
        lint: 'oxlint .',
      },
    });
    const config = createConfig({
      dirPath,
      isRoot: true,
      packageJson: readPackageJson(dirPath),
    });

    spawnSyncMock.mockImplementation((command, args, cwd) => {
      if (command === 'yarn' && args[0] === 'exec' && args[1] === 'sort-package-json' && args[2] === 'package.json') {
        const packageJsonPath = path.join(cwd, 'package.json');
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as PackageJson;
        // Simulate the target repository formatter by rewriting the file from the
        // current in-memory content using the project's own sort-package-json CLI.
        fs.writeFileSync(packageJsonPath, `${JSON.stringify(sortPackageJson(packageJson), undefined, 2)}\n`);
      }
    });

    await generatePackageJson(config, config, false);

    expect(spawnSyncMock).toHaveBeenCalledWith('yarn', ['exec', 'sort-package-json', 'package.json'], dirPath);
    expect(
      spawnSyncMock.mock.calls.filter(
        ([command, args, cwd]) =>
          command === 'yarn' &&
          args[0] === 'exec' &&
          args[1] === 'sort-package-json' &&
          args[2] === 'package.json' &&
          cwd === dirPath
      )
    ).toHaveLength(1);
    expect(readPackageJsonText(dirPath)).toBe(
      `${JSON.stringify(sortPackageJson(readPackageJson(dirPath)), undefined, 2)}\n`
    );
  });
});

async function createPackageDir(packageJson: PackageJson): Promise<string> {
  const dirPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wbfy-package-json-format-'));
  await fs.promises.writeFile(path.join(dirPath, 'package.json'), `${JSON.stringify(packageJson, undefined, 2)}\n`);
  await fs.promises.writeFile(path.join(dirPath, '.prettierignore'), '');
  return dirPath;
}

function readPackageJson(dirPath: string): PackageJson {
  return JSON.parse(fs.readFileSync(path.join(dirPath, 'package.json'), 'utf8')) as PackageJson;
}

function readPackageJsonText(dirPath: string): string {
  return fs.readFileSync(path.join(dirPath, 'package.json'), 'utf8');
}
