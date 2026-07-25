import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { findTestStructureViolations, reportTestStructureViolations } from '../../src/utils/testStructure.js';

describe('findTestStructureViolations', () => {
  const packageJson = {};

  it('accepts the canonical layout', async () => {
    const dirPath = await createProjectDir(
      ['test/e2e', 'test/debug', 'test/fixtures'],
      ['test/unit/example.test.ts', 'test/helpers/shared.ts', 'src/index.ts']
    );
    expect(findTestStructureViolations({ dirPath, packageJson })).toEqual([]);
  });

  it('accepts a project without a test directory', async () => {
    const dirPath = await createProjectDir([]);
    expect(findTestStructureViolations({ dirPath, packageJson })).toEqual([]);
  });

  // The regression this convention removes: files directly under test/ were silently never run.
  it('rejects files directly under test/ and unknown directories', async () => {
    const dirPath = await createProjectDir(['test/integration'], ['test/example.test.ts']);
    expect(findTestStructureViolations({ dirPath, packageJson }).toSorted()).toEqual([
      'test/example.test.ts',
      'test/integration',
    ]);
  });

  it('rejects test files under test/helpers/ and src/', async () => {
    const dirPath = await createProjectDir([], ['test/helpers/nested/a.test.ts', 'src/nested/b.spec.tsx']);
    expect(findTestStructureViolations({ dirPath, packageJson }).toSorted()).toEqual([
      'src/nested/b.spec.tsx',
      'test/helpers/nested/a.test.ts',
    ]);
  });

  it('allows test files inside test/fixtures/', async () => {
    const dirPath = await createProjectDir([], ['test/fixtures/app/test/unit/example.test.ts']);
    expect(findTestStructureViolations({ dirPath, packageJson })).toEqual([]);
  });

  it('ignores hidden entries such as .DS_Store', async () => {
    const dirPath = await createProjectDir([], ['test/.DS_Store', 'test/unit/example.test.ts', '.tmp/a.test.ts']);
    expect(findTestStructureViolations({ dirPath, packageJson })).toEqual([]);
  });

  it('rejects test files outside test/ such as the project root and scripts/', async () => {
    const dirPath = await createProjectDir([], ['outside.test.ts', 'scripts/deploy.spec.ts']);
    expect(findTestStructureViolations({ dirPath, packageJson }).toSorted()).toEqual([
      'outside.test.ts',
      'scripts/deploy.spec.ts',
    ]);
  });

  it('skips nested packages, which are validated as their own projects', async () => {
    const dirPath = await createProjectDir([], ['packages/app/package.json', 'packages/app/stray.test.ts']);
    expect(findTestStructureViolations({ dirPath, packageJson })).toEqual([]);
  });

  it('rejects a Playwright config without test/e2e except on a workspace root', async () => {
    const dirPath = await createProjectDir(['test/unit'], ['playwright.config.ts']);
    expect(findTestStructureViolations({ dirPath, packageJson })).toEqual(['playwright.config.ts']);
    expect(findTestStructureViolations({ dirPath, packageJson: { workspaces: ['packages/*'] } })).toEqual([]);
  });
});

describe('reportTestStructureViolations', () => {
  it('reports every violating project and passes a clean one', async () => {
    const cleanDirPath = await createProjectDir([], ['test/unit/example.test.ts']);
    const violatingDirPath = await createProjectDir([], ['test/example.test.ts']);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(
        reportTestStructureViolations([
          { dirPath: cleanDirPath, name: 'clean', packageJson: {} },
          { dirPath: violatingDirPath, name: 'violating', packageJson: {} },
        ])
      ).toBe(true);
      expect(consoleError).toHaveBeenCalledOnce();
      expect(consoleError.mock.calls[0]?.[0]).toContain('violating');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('passes when every project follows the convention', async () => {
    const dirPath = await createProjectDir([], ['test/unit/example.test.ts']);
    expect(reportTestStructureViolations([{ dirPath, name: 'clean', packageJson: {} }])).toBe(false);
  });
});

const dirPaths: string[] = [];

afterEach(async () => {
  await Promise.all(dirPaths.splice(0).map((dirPath) => fs.rm(dirPath, { force: true, recursive: true })));
});

async function createProjectDir(subDirNames: string[], fileNames: string[] = []): Promise<string> {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-test-layout-'));
  dirPaths.push(dirPath);
  for (const subDirName of subDirNames) {
    await fs.mkdir(path.join(dirPath, subDirName), { recursive: true });
  }
  for (const fileName of fileNames) {
    await fs.mkdir(path.dirname(path.join(dirPath, fileName)), { recursive: true });
    await fs.writeFile(path.join(dirPath, fileName), '');
  }
  return dirPath;
}
